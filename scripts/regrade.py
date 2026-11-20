#!/usr/bin/env python3
"""Grade some tickets of a finished step again, without re-running the step.

    python3 scripts/regrade.py <job dir> --step stage0                 # the step's tickets lost to us
    python3 scripts/regrade.py <job dir> --step Rnoisy --ids key-06,case-13
    python3 scripts/regrade.py <job dir> --step stage0 --dry-run       # only list what it would do
    python3 scripts/regrade.py <job dir> --step stage0 --rebuild-only  # rebuild scores and report, run nothing
    python3 scripts/regrade.py <job dir> --step stage0 --rebuild-only --reblame --tests tasks/redwood-inference/tests
                                                                       # relabel failures with a newer grader
    python3 scripts/regrade.py <job dir> --step stage5 --rebuild-only --reblame --ids receipt-ask-04 --tests ...
                                                                       # relabel only these tickets
    python3 scripts/regrade.py <job dir> --step stage3 --replays-only --tests tasks/redwood-inference/tests
                                                                       # replay the failed tickets again with this grader
                                                                       # (live results kept; e.g. a changed replay hint)

For tickets that failed because of us or the model provider (a sandbox that never started, a provider that
dropped the call), not for tickets the bot simply got wrong: grading those again until they pass would
inflate the score.

1. Runs the chosen tickets (and the other half of any follow-up pair they are in) with the grader's own
   `verify.py run`, inside the verifier image built from the run's own tests/ (the task path in the job's
   config.json, so the same grader the run used), against the bot that step was graded with
   (steps/<step>/verifier/bot), on Daytona, without replays. Same per-step settings as harbor: STAGE and the
   [verifier.env] models.
2. Puts the new results of the chosen tickets in place of the old ones and rebuilds the step's results.json,
   scores.json, reward.txt, report.md and architecture.json with the grader's own `finish`.
3. Keeps the old files and the new run in steps/<step>/verifier/regrade-<time>/ (before/, run/), and writes
   regrade.json there and a "regraded" entry in scores.json, so a report says which tickets were graded again.

Harbor's own step result.json (the reward harbor recorded) is not changed.
"""
import argparse
import datetime
import re
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUTPUTS = ["results.json", "scores.json", "reward.txt", "report.md", "architecture.json"]

RESCORE = r"""
import json, os, sys
from pathlib import Path
sys.path.insert(0, "/tests")
import verify, diagnose
logs = Path("/logs/verifier")
cases = verify.load_json(sys.argv[1]); rules = verify.load_json(sys.argv[2])
ids = set(json.load(open("/regrade/ids.json")))
new = {r["id"]: r for r in json.load(open("/regrade/results.json"))} if ids else {}
results = [new[r["id"]] if r["id"] in ids else r for r in json.load(open(logs / "results.json"))]
# finish() reads each ticket's runtime trace from the result, but the first finish() dropped it from results.json
# after writing it to traces/<id>.jsonl: put it back, or the architecture card sees an untraced step.
for r in results:
    t = logs / "traces" / f"{r['id']}.jsonl"
    if t.exists() and not r.get("trace"):
        r["trace"] = [e for e in map(json.loads, filter(str.strip, t.read_text().splitlines())) if e.get("kind") != "llm"]
bot = verify.BOT.parent
bot_files = diagnose.snapshot_bot(bot, logs / "bot")
self_report = diagnose.load_self_report(bot / "ARCHITECTURE.json")
hook_dir, trace_dir = verify.install_llm_hook(Path("/srv/observe"))
baseline = diagnose.baseline_imports(hook_dir, trace_dir / "_baseline.jsonl")
if len(sys.argv) > 3 and sys.argv[3] == "reblame":
    # Blame each failed ticket again with this grader (e.g. a newer rule check), from what the step saved.
    by_id, rules_by_id = {c["id"]: c for c in cases}, {r["id"]: r for r in rules}
    stored = diagnose.stored_corpus(bot)
    only = set(json.load(open("/regrade/reblame_ids.json")))  # empty: every failed ticket
    saved = {r["id"]: r for r in results}
    for r in results:
        if r.get("passed") or r["id"] not in by_id or (only and r["id"] not in only):
            continue
        case = by_id[r["id"]]
        if not r.get("checks") and case.get("after") and case.get("require_attempt"):
            # Older graders missed a follow-up's attempt-id check when the first ticket had quoted the id; the
            # follow-up needs only its own requests and the first ticket's (for the id), and both were saved.
            head = saved.get(case["after"]) or {}
            r["checks"] = diagnose.attempt_checks(case, None, r.get("requests") or [], verify.lookup,
                                                  (head.get("requests") or []) + (r.get("requests") or []))
        if not r.get("checks"):
            continue
        if any(b.get("blame") in ("trace lost", "customer fault") for b in r.get("blame") or []):
            continue  # set by the grader after the checks (watcher gap, customer model): not something to recompute
        r["blame"] = diagnose.blame_case(by_id[r["id"]], r["checks"], rules_by_id, r.get("model_calls") or [],
                                         r.get("bot_problem") or "", stored, r.get("bot_stderr_tail") or "")
        if isinstance(r.get("replay"), dict):
            diagnose.apply_replay(r["blame"], r["replay"].get("passed"))
verify.finish(results, cases, rules, bot, logs, baseline, self_report, bot_files, None)
"""


def step_files(tests, task, step):
    """The cases, rules and seed test.sh grades this step with: a staged task (redwood-inference,
    skyway-air) keeps a later stage's cases and rules in stages/<step>/, and its seed there too when the stage has
    its own (skyway); otherwise the seed is tests/seed."""
    staged = tests / f"stages/{step}"
    if step != "stage0" and (staged / "cases.json").exists():
        seed = staged / "seed" if (staged / "seed").is_dir() else tests / "seed"
        return staged / "cases.json", staged / "rules.json", seed
    return tests / "cases.json", tests / "rules.json", tests / "seed"


def env_file_values(path, names):
    """The values of these names in a KEY=VALUE env file (the run's .env), read without printing anything."""
    out = {}
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return out
    for line in lines:
        key, sep, value = line.strip().partition("=")
        key = key.removeprefix("export ").strip()
        if sep and key in names and not key.startswith("#"):
            out[key] = value.strip().strip('"').strip("'")
    return out


def verifier_env(task_dir, env_file=None):
    """[verifier.env] model settings, resolved as the run resolves them: "${NAME:-default}" takes NAME from this
    shell, then from --env-file (the run's .env), then the default. These go to docker as -e and override the env
    file, so a setting only in .env must be read here, or the task.toml default wins."""
    import tomllib
    env = tomllib.loads((task_dir / "task.toml").read_text()).get("verifier", {}).get("env", {})
    names = ("BOT_MODEL", "EMBED_MODEL", "CUSTOMER_MODEL", "ARCHITECTURE")  # ARCHITECTURE: skyway-air only
    from_file = env_file_values(env_file, names) if env_file else {}
    out = {}
    for k in names:
        v = str(env.get(k, ""))
        if v.startswith("${") and ":-" in v:  # "${BOT_MODEL:-openai/gpt-5.6-sol}"
            v = os.environ.get(k) or from_file.get(k) or v[v.index(":-") + 2:-1]
        if v:
            out[k] = v
    return out


def architecture_of(cfg):
    """skyway-air: the architecture a run was given (the name of its architectures/<name>.md extra instruction),
    so a regraded stage gets the same architecture check as the run. "" when the run had none."""
    for p in cfg.get("extra_instruction_paths") or []:
        m = re.search(r"/architectures/([^/]+)\.md$", str(p))
        if m:
            return m.group(1)
    return ""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("job", help="a finished job folder, e.g. tasks/redwood-inference/jobs/2026-10-15__13-06-02")
    ap.add_argument("--step", required=True, help="the step to fix, e.g. stage0 or Rnoisy")
    ap.add_argument("--ids", help="comma-separated ticket ids (default: the step's tickets lost to us); "
                    "with --reblame, the only tickets blamed again")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--env-file", default=str(REPO / ".env"), help="keys for the models and Daytona (never printed)")
    ap.add_argument("--dry-run", action="store_true", help="list the tickets and files, change nothing")
    ap.add_argument("--rebuild-only", action="store_true",
                    help="run no tickets: rebuild the step's scores and report from its results.json as it is")
    ap.add_argument("--reblame", action="store_true",
                    help="with --rebuild-only: blame each failed ticket again with the grader in --tests")
    ap.add_argument("--tests", help="grader folder to use instead of the run's own (e.g. tasks/<task>/tests in this repo)")
    ap.add_argument("--replays-only", action="store_true",
                    help="keep every live result and run the failed tickets' replays again (verify.py replay), on Daytona")
    args = ap.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.step):
        sys.exit(f"not a step name: {args.step!r}")
    if args.reblame and not args.rebuild_only:
        sys.exit("--reblame goes with --rebuild-only")
    if args.replays_only and (args.rebuild_only or args.ids):
        sys.exit("--replays-only replays every failed ticket of the step; it takes no --ids or --rebuild-only")

    job = Path(args.job).resolve()
    cfg = json.loads((job / "config.json").read_text())
    task_dir = Path(next(t["path"] for t in cfg["tasks"] if t.get("path")))
    if args.tests and not (task_dir / "tests/verify.py").exists():
        # A run made from another checkout that is gone: --tests names the grader, and its task folder has the rest.
        task_dir = Path(args.tests).resolve().parent
    if not (task_dir / "tests/verify.py").exists():
        sys.exit(f"the run's task folder {task_dir} is gone: it holds the grader the run used")
    step = next(iter(job.glob(f"*/steps/{args.step}")), None)
    if step is None or not (step / "verifier/results.json").exists():
        sys.exit(f"{args.step}: no graded step in {job}")
    verifier = step / "verifier"
    bot = verifier / "bot"
    if not (bot / "run").exists():
        sys.exit(f"{bot}: the step's bot was not saved")

    tests_dir = Path(args.tests).resolve() if args.tests else task_dir / "tests"
    if not (tests_dir / "verify.py").exists():
        sys.exit(f"{tests_dir}: no grader there")
    sys.path.insert(0, str(tests_dir))
    import verify  # ours_only, split_cases: the run's own grader
    cases_path, rules_path, seed_path = step_files(tests_dir, task_dir.name, args.step)
    cases = json.loads(cases_path.read_text())
    by_id = {c["id"]: c for c in cases}
    old = json.loads((verifier / "results.json").read_text())
    prior = json.loads((verifier / "scores.json").read_text()).get("regraded", [])
    reblame_ids = [i.strip() for i in (args.ids or "").split(",") if i.strip()] if args.reblame else []
    unknown = [i for i in reblame_ids if i not in by_id]
    if unknown:
        sys.exit(f"not tickets of {args.step}: {', '.join(unknown)}")
    if args.rebuild_only or args.replays_only:
        ids = []
    elif args.ids:
        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        unknown = [i for i in ids if i not in by_id]
        if unknown:
            sys.exit(f"not tickets of {args.step}: {', '.join(unknown)}")
    else:
        ids = [r["id"] for r in old if verify.ours_only(r)]
    if not ids and not args.rebuild_only and not args.replays_only:
        print(f"{args.step}: no tickets lost to us; nothing to do (pass --ids to choose tickets)")
        return
    # A follow-up pair runs together: its other half runs too, but keeps its old result.
    heads = {c["after"]: c["id"] for c in cases if c.get("after")}
    run_ids = list(dict.fromkeys(
        x for i in ids for x in (i, by_id[i].get("after"), heads.get(i)) if x))
    before = {r["id"]: r["passed"] for r in old}
    print(f"{job.name} {args.step}: " + ("replaying the failed tickets again, live results kept" if args.replays_only else
                                         "rebuilding the scores, no tickets run"
                                         + (f", blaming again {', '.join(reblame_ids) or 'every failed ticket'}" if args.reblame else "")
                                         if args.rebuild_only else f"grading again {', '.join(ids)}")
          + (f" (with {', '.join(x for x in run_ids if x not in ids)}, the other half of a pair)" if len(run_ids) > len(ids) else ""))
    print(f"  grader: {tests_dir}   bot: {bot}   cases: {cases_path.relative_to(tests_dir)}")
    if args.dry_run:
        return

    image = f"regrade-{task_dir.name}" + ("-alt" if args.tests else "")  # another grader: its own image
    built = subprocess.run(["docker", "build", "-q", "-t", image, str(tests_dir)], stdout=subprocess.DEVNULL)
    if built.returncode and subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode:
        sys.exit(f"could not build {image} from {tests_dir}")  # two regrades building at once: the other's image is fine
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    keep = verifier / f"regrade-{stamp}"
    (keep / "before").mkdir(parents=True)
    (keep / "run").mkdir()
    for f in OUTPUTS:
        if (verifier / f).exists():
            shutil.copy2(verifier / f, keep / "before" / f)

    # PYTHONUNBUFFERED: the grader's per-ticket lines reach `docker logs` as they happen, not at exit.
    settings = verifier_env(task_dir, args.env_file)
    if not settings.get("ARCHITECTURE") and architecture_of(cfg):
        settings["ARCHITECTURE"] = architecture_of(cfg)  # from the run's config when this shell does not set it
    import tomllib
    step_env = next((st.get("verifier", {}).get("env", {}) for st in tomllib.loads((task_dir / "task.toml").read_text())
                     .get("steps", []) if st.get("name") == args.step), {})
    if step_env.get("WORLD_NOW"):
        settings["WORLD_NOW"] = step_env["WORLD_NOW"]  # the stage's world time: the bot's clock (skyway)
    envs = [x for k, v in {**settings, "TICKET_SANDBOX": "daytona", "STAGE": args.step,
                           "PYTHONUNBUFFERED": "1"}.items()
            for x in ("-e", f"{k}={v}")]
    rel_cases = cases_path.relative_to(tests_dir)
    rel_rules = rules_path.relative_to(tests_dir)
    rel_seed = seed_path.relative_to(tests_dir)
    owner = f"{os.getuid()}:{os.getgid()}"

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "cases.json").write_text(json.dumps([by_id[i] for i in run_ids]))
        (tmp / "ids.json").write_text(json.dumps(ids))
        (tmp / "reblame_ids.json").write_text(json.dumps(reblame_ids))
        (tmp / "rescore.py").write_text(RESCORE)
        shutil.copytree(bot, tmp / "bot", symlinks=True)
        # Paths reach the container shell only as positional arguments ("$1"...), never inside the script text.
        mounts = ["-v", f"{tmp}:/regrade", "-v", f"{tmp / 'bot'}:/app/bot"]
        new = {}
        if ids:
            # 1. the chosen tickets (no replays; the judge grades)
            run = subprocess.run(
                ["docker", "run", "--rm", "--env-file", args.env_file, *envs, *mounts, "-v", f"{keep / 'run'}:/logs/verifier",
                 image, "sh", "-c",
                 'chmod -R a+rwX /app/bot; python3 /tests/verify.py run --cases /regrade/cases.json --rules "$1" '
                 '--seed "$4" --workers "$2" --no-replay; s=$?; chown -R "$3" /logs/verifier; exit $s',
                 "sh", f"/tests/{rel_rules}", str(args.workers), owner, f"/tests/{rel_seed}"],
                capture_output=True, text=True)
            (keep / "run" / "stdout.txt").write_text(run.stdout + run.stderr)
            if not (keep / "run" / "results.json").exists():
                sys.exit(f"the regrade run wrote no results (exit {run.returncode}); see {keep / 'run' / 'stdout.txt'}. "
                         f"The step's files are unchanged.")
            shutil.copy2(keep / "run" / "results.json", tmp / "results.json")
            new = {r["id"]: r for r in json.loads((tmp / "results.json").read_text())}
            missing = [i for i in ids if i not in new]
            if missing:
                sys.exit(f"the regrade run has no result for {', '.join(missing)}; the step's files are unchanged")
        # 2. rebuild the step's scores from the merged results, in a copy of the step's verifier folder
        stage = tmp / "logs"
        shutil.copytree(verifier, stage, symlinks=True, ignore=shutil.ignore_patterns("regrade-*"))
        for f in (keep / "run" / "traces").glob("*.jsonl"):
            shutil.copy2(f, stage / "traces" / f.name)  # the new run's traces replace the chosen tickets' old ones
        if args.replays_only:
            # verify.py replay: the step's live results, replays run again, then finish() rewrites the step's files
            shutil.copy2(verifier / "results.json", tmp / "results.json")
            res = subprocess.run(
                ["docker", "run", "--rm", "--env-file", args.env_file, *envs, *mounts, "-v", f"{stage}:/logs/verifier",
                 image, "sh", "-c",
                 'chmod -R a+rwX /app/bot; python3 /tests/verify.py replay --cases "$1" --rules "$2" --seed "$5" '
                 '--results /regrade/results.json --workers "$4"; s=$?; chown -R "$3" /logs/verifier; exit $s',
                 "sh", f"/tests/{rel_cases}", f"/tests/{rel_rules}", owner, str(args.workers), f"/tests/{rel_seed}"],
                capture_output=True, text=True)
            (keep / "replay.txt").write_text(res.stdout + res.stderr)
            if res.returncode or not (stage / "scores.json").exists():
                sys.exit(f"the replays failed (exit {res.returncode}); see {keep / 'replay.txt'}. The step's files are unchanged.")
        else:
            res = subprocess.run(
                ["docker", "run", "--rm", "--env-file", args.env_file, *envs, *mounts, "-v", f"{stage}:/logs/verifier",
                 image, "sh", "-c",
                 'chmod -R a+rwX /app/bot; python3 /regrade/rescore.py "$1" "$2" "$4"; s=$?; chown -R "$3" /logs/verifier; exit $s',
                 "sh", f"/tests/{rel_cases}", f"/tests/{rel_rules}", owner, "reblame" if args.reblame else ""],
                capture_output=True, text=True)
            (keep / "rescore.txt").write_text(res.stdout + res.stderr)
            if res.returncode or not (stage / "scores.json").exists():
                sys.exit(f"rebuilding the scores failed (exit {res.returncode}); see {keep / 'rescore.txt'}. "
                         f"The step's files are unchanged.")
        # 3. note what was graded again (keeping earlier regrades: finish() wrote fresh files), then put them in place
        history = list(prior)
        if args.replays_only:
            history.append({"at": stamp, "replays_only": True, "grader": str(tests_dir)})
        if ids:
            history.append({"at": stamp, "tickets": ids, "with": [x for x in run_ids if x not in ids],
                            "before": {i: before.get(i) for i in ids}, "after": {i: new[i]["passed"] for i in ids}})
        scores = json.loads((stage / "scores.json").read_text())
        if history:
            scores["regraded"] = history
        (stage / "scores.json").write_text(json.dumps(scores, indent=2))
        if history:
            with open(stage / "report.md", "a") as f:
                f.write("\n## Graded again\n\n" + "".join(
                    (f"- {n['at']}: the failed tickets' replays run again with scripts/regrade.py --replays-only (live "
                     f"results kept; old files in regrade-{n['at']}/before/).\n") if n.get("replays_only") else
                    (f"- {n['at']}: {', '.join(n['tickets'])} graded again with scripts/regrade.py (old files in "
                     f"regrade-{n['at']}/before/): " + ", ".join(f"{i} {'passed' if n['after'][i] else 'failed'}" for i in n["tickets"])
                     + ".\n") for n in history if n.get("replays_only") or n.get("tickets")))
        (keep / "regrade.json").write_text(json.dumps(history[-1] if ids or args.replays_only else {"at": stamp, "rebuilt": True}, indent=2))
        for f in OUTPUTS:
            shutil.copy2(stage / f, verifier / f)
        for f in (stage / "traces").glob("*.jsonl"):
            if any(f.stem == i or f.stem.startswith(i + "-") for i in ids):  # the ticket's own traces and its replays'
                shutil.copy2(f, verifier / "traces" / f.name)

    old_passed = sum(before.values())
    new_passed = sum(r["passed"] for r in json.loads((verifier / "results.json").read_text()))
    if ids:
        print("  " + ", ".join(f"{i}: {before.get(i)} -> {new[i]['passed']}" for i in ids))
    print(f"  {args.step}: {old_passed}/{len(old)} -> {new_passed}/{len(old)} passed. Old files: {keep / 'before'}")


if __name__ == "__main__":
    main()
