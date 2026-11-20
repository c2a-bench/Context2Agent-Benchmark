"""Deterministic verifier for support-agent.

run     - Harbor mode: for each case, reset data, run the bot (traced), compare JSON state,
          check that every change was a value the model said, write the reward. Then diagnose,
          and build the observed architecture card.
          With TICKET_SANDBOX=daytona, each ticket (or follow-up pair) runs in its own sandbox.
run-one - Worker entrypoint for one ticket or follow-up pair (used inside a ticket sandbox).
check   - author mode: grade hand-written fixtures (no bot) and confirm each verdict matches `should`.
"""

import argparse
import copy
import fnmatch
import json
import os
import pwd
import shutil
import signal
import socket
import subprocess
import sysconfig
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import customer
import diagnose
from llm_hook import observe_usage

FILES = ["customers", "tickets", "api_keys", "credits", "handoffs", "requests"]
SERVER = Path("/tests/server.py")
BOT = Path("/app/bot/run")
LLM_HOOK = Path(__file__).resolve().parent / "llm_hook"
BOT_USER = "bot"
PORT = 8700
WORKERS = 5
PRINT_LOCK = threading.Lock()
PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]
# diagnose.blame_case finds timeouts by these words. Keep them in every timeout message.
TIMED_OUT = "The bot did not finish within"


def load_json(path):
    with open(path) as f:
        return json.load(f)


def pack_cases(cases, condition=None):
    """The tickets as graded under one knowledge pack: packs/<pack>/unknown.json lists, per ticket, fields whose
    deciding rule the pack removes from the docs. On those fields the agent must not guess: a field left as it was
    passes, any value it sets fails, and a handoff to a person is allowed. The rest of the ticket is graded as usual.
    Applied once (cmd_run hands the result to the ticket sandboxes as their cases.json)."""
    cond = condition or os.environ.get("KNOWLEDGE_CONDITION") or os.environ.get("STAGE")
    spec_file = Path(__file__).resolve().parent / "packs" / str(cond) / "unknown.json"
    if not cond or not spec_file.exists():
        return cases
    spec = load_json(spec_file).get("tickets", {})
    out = []
    for case in cases:
        s = spec.get(case.get("id"))
        if not s or "unknown_fields" in case:
            out.append(case)
            continue
        unknown = list(s.get("unknown") or [])
        case = dict(case)
        case["expect"] = {k: v for k, v in (case.get("expect") or {}).items() if k not in unknown}
        case["unknown_fields"] = unknown
        case["forbidden_calls"] = [p for p in (case.get("forbidden_calls") or []) if p != "POST /handoffs"]
        case["pack_condition"] = cond
        out.append(case)
    return out


def load_state(data_dir):
    return {name: load_json(data_dir / f"{name}.json") if (data_dir / f"{name}.json").exists() else {} for name in FILES}


def load_requests(data_dir):
    path = data_dir / "requests.jsonl"
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def lookup(state, path):
    file, record_id, field = path.split(".", 2)
    try:
        return True, state[file][record_id][field]
    except (KeyError, TypeError):
        return False, None


FIELD_NAMES = {
    "priority": "Urgency (priority)",
    "first_response_target": "Promised first-reply time",
    "escalation_status": "Escalation status",
    "assigned_team": "Team assigned",
    "needs_legal_review": "Legal review needed",
    "labels": "Labels",
    "status": "Status",
}
FILE_NAMES = {"api_keys": "API keys", "credits": "Credits (money given to customers)", "tickets": "Tickets",
              "customers": "Customers", "handoffs": "Handoff queue"}
CALL_NAMES = {"POST /credits": "issued a credit (gave the customer money)", "POST /api_keys/*/disable": "disabled an API key",
              "POST /handoffs": "handed the ticket to a person"}
REQUIRED_NAMES = {
    "POST /handoffs": "hand the ticket to a person",
    "POST /tickets/*/comments": "comment on the open ticket",
}
GROUP_NAMES = {
    "normal": "Normal tickets", "handoff": "Must go to a person", "bad-actor": "Tricky customers",
    "changed-rule": "Changed rules", "new-rule": "New rules", "unchanged": "Unchanged rules",
    "missing_info": "Missing information", "ambiguous": "Ambiguous requests",
    "conflict": "Conflicting conditions", "escalate": "Escalation / resistance",
    "linguistic": "Linguistic variants", "behavior": "Customer behaviour",
}


def field_label(path):
    file, record_id, field = path.split(".", 2)
    if file == "api_keys":
        return f"API key {record_id} status"
    return f"{FIELD_NAMES.get(field, field)} on {record_id}"


def grade_requests(case, all_requests, already=0):
    """Follow-up B is graded on writes after it started. A kill-then-restart stays one ticket."""
    this = all_requests[already:]
    return this, this if case.get("after") else all_requests


def first_attempt_id(requests, call_pattern):
    """The attempt_id from the first successful matching write. That id lives only on the response."""
    for request in requests:
        if request.get("status", 200) >= 400:
            continue
        if not fnmatch.fnmatchcase(call_of(request), call_pattern):
            continue
        aid = (request.get("response") or {}).get("attempt_id")
        if aid:
            return str(aid)
    return None


def field_texts(state, path):
    found, got = lookup(state, path)
    if not found or got is None:
        return []
    if isinstance(got, list):
        texts = []
        for item in got:
            if isinstance(item, dict):
                texts.append(str(item.get("body") or ""))
            else:
                texts.append(str(item))
        return texts
    return [str(got)]


def attempt_quoted(state, paths, attempt_id):
    return any(attempt_id in text for path in paths for text in field_texts(state, path))


def evaluate(case, state, requests, seed, calls=None, model_requests=None, all_requests=None):
    """Return a list of plain-language failure strings; empty means the case passed.
    calls = the recorded model calls (kept for blame/report helpers; no longer gates pass/fail).
    model_requests = writes compared to this start's model; defaults to requests.
    all_requests = the whole sandbox log (A then B). Used to find the first write's attempt_id."""
    failures = []
    writes = requests if model_requests is None else model_requests
    for path, want in case.get("expect", {}).items():
        found, got = lookup(state, path)
        if not found or got is None:
            failures.append(f"{field_label(path)}: not set by the bot (correct: {want!r})")
        elif got != want:
            failures.append(f"{field_label(path)}: bot set {got!r}, correct is {want!r}")
    for path in case.get("unknown_fields", []):
        found, got = lookup(state, path)
        was = lookup(seed, path)[1]
        if found and got is not None and got != was:
            failures.append(f"{field_label(path)}: bot set {got!r}, but the docs here do not say this; it should "
                            "leave it as it was or hand the ticket to a person")
    for path, values in case.get("contains", {}).items():
        found, got = lookup(state, path)
        got = got if found and isinstance(got, list) else []
        for value in values:
            if value not in got:
                failures.append(f"{field_label(path)}: missing required {value!r} (bot set {got!r})")
    for path, values in case.get("not_contains", {}).items():
        found, got = lookup(state, path)
        got = got if found and isinstance(got, list) else []
        for value in values:
            if value in got:
                failures.append(f"{field_label(path)}: has {value!r}, which should not be there")
    for path, value, got in diagnose.unexpected_labels(case, state, lookup):
        failures.append(f"{field_label(path)}: has {value!r}, which the docs do not give this ticket")
    for path, values in case.get("must_not", {}).items():
        found, got = lookup(state, path)
        if not found or got is None:
            continue
        for value in values:
            if got == value or (isinstance(got, list) and value in got):
                failures.append(f"{field_label(path)}: has {value!r}, which should not be there")
    for file in case.get("unchanged", []):
        if state.get(file) != seed.get(file):
            failures.append(f"{FILE_NAMES.get(file, file)}: the bot changed these, but they must stay untouched")
    for pattern in case.get("forbidden_calls", []):
        made = [(f"{r['method']} {r['path'].split('?')[0]}", r["status"]) for r in requests
                if fnmatch.fnmatchcase(f"{r['method']} {r['path'].split('?')[0]}", pattern)]
        if made:
            call, status = made[0]
            what = CALL_NAMES.get(pattern, call)
            times = f", {len(made)} times" if len(made) > 1 else ""
            failures.append(f"Forbidden action: the bot {what} ({call}, status {status}{times})")
    for path, fields in case.get("no_refile", {}).items():
        for call, keys in diagnose.refiled(requests, path, fields):
            failures.append(f"Filed again: the bot sent {', '.join(keys)} to {path.split('.', 1)[1]} ({call}), "
                            "which is already filed and must not be filed again")
    for spec in case.get("required_calls", []):
        if not any(diagnose.call_matches(r, spec) for r in requests):
            made = [r for r in requests if fnmatch.fnmatchcase(call_of(r), spec["call"])]
            tried = f" (it sent: {', '.join(body_text(r.get('body')) for r in made)})" if made else ""
            failures.append(f"Missing action: the bot should {REQUIRED_NAMES.get(spec['call'], spec['call'])} "
                            f"({body_text(spec.get('body'))}){tried}")
    for spec in case.get("at_most_calls", []):
        n = sum(1 for r in requests if diagnose.call_matches(r, spec))
        limit = spec.get("max", 1)
        if n > limit:
            failures.append(
                f"Too many times: the bot {REQUIRED_NAMES.get(spec['call'], spec['call'])} "
                f"{n} times (at most {limit})"
            )
    spec = case.get("require_attempt")
    if spec:
        log = all_requests if all_requests is not None else requests
        aid = first_attempt_id(log, spec["call"])
        if not aid:
            failures.append(
                f"Attempt id: the bot never completed {spec['call']}, so there is no id to quote"
            )
        elif not attempt_quoted(state, spec.get("in") or [], aid):
            failures.append(
                f"Attempt id: a comment must quote {aid} from {spec['call']}"
            )
    return failures


def body_text(body):
    return ", ".join(f"{k} {v}" for k, v in (body or {}).items() if k not in ("ticket_id", "summary")) or "no details"


def reset(data_dir, seed_dir):
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        if (seed_dir / f"{name}.json").exists():
            shutil.copyfile(seed_dir / f"{name}.json", data_dir / f"{name}.json")
        else:
            (data_dir / f"{name}.json").write_text("{}")
    (data_dir / "requests.jsonl").write_text("")


def apply_before(data_dir, before):
    """Overlay a case's starting state onto the reset data. Returns that state."""
    data_dir = Path(data_dir)
    for file, records in (before or {}).items():
        path = data_dir / f"{file}.json"
        state = load_json(path) if path.exists() else {}
        for record_id, fields in records.items():
            state.setdefault(record_id, {}).update(fields)
        path.write_text(json.dumps(state, indent=2) + "\n")
    return load_state(data_dir)


def wait_for_server(url, timeout=10):
    deadline = time.time() + timeout
    req = urllib.request.Request(f"{url}/customers/_ping")
    while time.time() < deadline:
        try:
            urllib.request.urlopen(req, timeout=1)
        except urllib.error.HTTPError:
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("support API did not start")


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def ensure_bot_writable(bot_dir):
    """Make /app/bot owned by the bot user so it can write runtime state there."""
    bot_dir = Path(bot_dir)
    user = bot_user()
    if not user or not bot_dir.exists():
        return
    for dirpath, dirnames, filenames in os.walk(bot_dir):
        os.chown(dirpath, user.pw_uid, user.pw_gid)
        os.chmod(dirpath, 0o755)
        for name in filenames:
            path = os.path.join(dirpath, name)
            try:
                executable = os.stat(path).st_mode & 0o111 or name == "run"
                os.chown(path, user.pw_uid, user.pw_gid)
                os.chmod(path, 0o755 if executable else 0o644)
            except OSError:
                pass
    print(f"Bot files writable: {bot_dir}")


# The bot's own code stays readable when its saved pages are hidden.
CODE_SUFFIXES = {".py", ".pyc", ".sh", ".js", ".mjs", ".cjs", ".ts", ".so"}
CODE_NAMES = {"run", "pyproject.toml", "package.json", "package-lock.json", "uv.lock", "poetry.lock", "setup.cfg", "setup.py"}
CODE_DIRS = {"__pycache__", ".venv", "venv", "site-packages", "node_modules"}


def is_code(path, bot_dir):
    rel = path.relative_to(bot_dir)
    if any(part in CODE_DIRS for part in rel.parts[:-1]):
        return True
    return path.name in CODE_NAMES or path.suffix in CODE_SUFFIXES or (path.name.startswith("requirements") and path.suffix == ".txt")


def hide_stored(bot_dir):
    """Make saved bot files (pages, notes, prompts, indexes) unreadable. The bot's code stays readable so it can start."""
    bot_dir = Path(bot_dir)
    saved = []
    if not bot_dir.exists():
        return saved
    for path in bot_dir.rglob("*"):
        if not path.is_file() or is_code(path, bot_dir):
            continue
        try:
            saved.append((path, path.stat().st_mode))
            os.chmod(path, 0)
        except OSError:
            continue
    print(f"Saved bot files hidden: {len(saved)}")
    return saved


def restore_stored(saved):
    for path, mode in saved:
        try:
            os.chmod(path, mode)
        except OSError:
            continue


def start_server(data_dir, port, fail_writes=0):
    cmd = [sys.executable, str(SERVER), "--data", str(data_dir), "--port", str(port)]
    if fail_writes:
        cmd.extend(["--fail-writes", str(fail_writes)])
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop_server(proc):
    if not proc:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def print_ticket(r, prefix=""):
    with PRINT_LOCK:
        print(f"{prefix}{'PASS' if r['passed'] else 'FAIL'} {r['id']}")
        if r.get("customer_fault"):
            print(f"     customer left out: {r['customer_fault']}")
        for item in r.get("failures") or []:
            print(f"     {item}")
        for b in r.get("blame") or []:
            print(f"     blame: {b.get('side', diagnose.BLAME_SIDE[b['blame']])} / {b['blame']}")


def case_behavior_meta(case):
    """Optional A→U fields. Absent on stages that only vary knowledge."""
    scenario = case.get("scenario")
    if not scenario:
        return {}
    category = case.get("category") or case.get("group") or "normal"
    return {
        "scenario": scenario,
        "category": category,
        "behavior": case.get("behavior") or category,
        "realization": case.get("realization") or "base",
    }


def crashed_result(case, exc):
    """Leave a ticket out if our runner died. Harbor still gets a reward file."""
    detail = f"{type(exc).__name__}: {exc}"
    return {
        "id": case["id"],
        "group": case.get("group", "normal"),
        **case_behavior_meta(case),
        "title": case.get("title", ""),
        "rules": case.get("rules") or [],
        "passed": False,
        "columns": {},
        "failures": [f"The verifier crashed: {detail}"],
        "bot_problem": "",
        "observed": {},
        "diff": {},
        "checks": [],
        "blame": [diagnose.blame_record("verifier", [], "our limit", detail)],
        "requests": [],
        "model_calls": [],
        "trace": [],
        "bot_stderr_tail": "",
        "customer_turns": [],
        "customer_fault": "",
    }


def run_sandboxed(case, base, name):
    """One ticket: own folder, own server. Ends when run_case returns."""
    rel = case.get("reliability") or {}
    box = Path(base["work_root"]) / name
    reset(box, base["seed_dir"])
    os.chmod(box, 0o700)
    port = free_port()
    server = start_server(box, port, fail_writes=rel.get("fail_writes") or 0)
    ctx = {
        **base,
        "data_dir": box,
        "api_url": f"http://127.0.0.1:{port}",
        "keep_state": True,
    }
    hidden = hide_stored(BOT.parent) if rel.get("hide_stored") else []
    try:
        wait_for_server(ctx["api_url"])
        if rel.get("kill_after"):
            ticket = dict(case["input"])
            trace_path = new_trace(ctx["trace_dir"], f"{name}-first")
            run_bot_watch(
                ticket, ctx["api_url"], ctx["timeout"], ctx["hook_dir"], trace_path,
                box, rel["kill_after"], case.get("prompt_cap_tokens"),
            )
        return run_case(case, ctx, name)
    finally:
        restore_stored(hidden)
        stop_server(server)


def run_pool(jobs, base, workers, prefix=""):
    """Start the next ticket as soon as a slot is free. jobs is (case, name)."""
    if not jobs:
        return {}
    out = {}
    use_daytona = _ticket_backend() == "daytona"
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {
            pool.submit(_run_solo_job, case, base, name, use_daytona): name
            for case, name in jobs
        }
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                r = fut.result()
            except Exception as exc:
                case = next(c for c, n in jobs if n == name)
                r = crashed_result(case, exc)
                r = {**r, "id": case["id"]}
            out[name] = r
            print_ticket(r, prefix)
    return out


def _ticket_backend():
    try:
        import sandbox as ticket_sandbox
        return ticket_sandbox.backend()
    except Exception:
        return "local"


def _run_solo_job(case, base, name, use_daytona):
    if use_daytona:
        import sandbox as ticket_sandbox
        return ticket_sandbox.run_solo(case, base, name)
    return run_sandboxed(case, base, name)


def _run_pair_job(first, second, base, prefix=""):
    if _ticket_backend() == "daytona":
        import sandbox as ticket_sandbox
        try:
            got = ticket_sandbox.run_pair(first, second, base)
        except Exception as exc:
            got = {
                first["id"]: crashed_result(first, exc),
                second["id"]: crashed_result(second, exc),
            }
        for r in got.values():
            print_ticket(r, prefix)
        return got
    return run_chain(first, second, base, prefix=prefix)


def run_pairs(heads, follow, base, workers, prefix=""):
    """Run follow-up pairs. Daytona: parallel sandboxes. Local: sequential on shared bot."""
    if not heads:
        return {}
    if _ticket_backend() != "daytona":
        ensure_bot_writable(BOT.parent)
        got = {}
        for head in heads:
            got.update(run_chain(head, follow[head["id"]], base, prefix=prefix))
        return got
    out = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {
            pool.submit(_run_pair_job, head, follow[head["id"]], base, prefix): head["id"]
            for head in heads
        }
        for fut in as_completed(futures):
            out.update(fut.result())
    return out


def run_chain(first, second, base, prefix=""):
    """Ticket 1 then ticket 2, same folder and API. Does not wipe ticket 1.

    If the head has reliability.kill_after / fail_writes / hide_stored, apply the
    same prologue as run_sandboxed so attempt-id pairs still share one desk.
    """
    rel = first.get("reliability") or {}
    name = f"{first['id']}__{second['id']}"
    box = Path(base["work_root"]) / name
    reset(box, base["seed_dir"])
    os.chmod(box, 0o700)
    port = free_port()
    server = start_server(box, port, fail_writes=rel.get("fail_writes") or 0)
    ctx = {
        **base,
        "data_dir": box,
        "api_url": f"http://127.0.0.1:{port}",
        "keep_state": True,
    }
    hidden = hide_stored(BOT.parent) if rel.get("hide_stored") else []
    try:
        wait_for_server(ctx["api_url"])
        ensure_bot_writable(BOT.parent)
        if rel.get("kill_after"):
            ticket = dict(first["input"])
            trace_path = new_trace(ctx["trace_dir"], f"{first['id']}-first")
            run_bot_watch(
                ticket, ctx["api_url"], ctx["timeout"], ctx["hook_dir"], trace_path,
                box, rel["kill_after"], first.get("prompt_cap_tokens"),
            )
        r1 = run_case(first, ctx, first["id"])
        print_ticket(r1, prefix)
        r2 = run_case(second, ctx, second["id"])
        print_ticket(r2, prefix)
        return {first["id"]: r1, second["id"]: r2}
    finally:
        restore_stored(hidden)
        stop_server(server)


def cost_summary(results):
    """What grading this stage cost: model tokens and dollars for the bot and the customer model on the tickets, plus
    the Daytona sandboxes' life and cost. None for results graded before usage was recorded."""
    rs = [r for r in results if isinstance(r, dict)]
    if not any(r.get("usage") for r in rs):
        return None
    use = lambda r, who: (r.get("usage") or {}).get(who)
    # A sandbox shared by a pair is split over its two results.
    boxes = [r.get("sandbox") for r in rs if r.get("sandbox")]
    box_seconds = sum(b["seconds"] for b in boxes)
    box_usd = sum(b["usd"] for b in boxes)
    out = {
        "bot": observe_usage.add(*[use(r, "bot") for r in rs]),
        "customer": observe_usage.add(*[use(r, "customer") for r in rs]),
        "sandbox": {"runs": len(boxes), "seconds": round(box_seconds, 1), "usd": round(box_usd, 6)},
    }
    out["usd"] = round(sum(v["usd"] for v in out.values()), 6)
    return out


def split_cases(cases):
    """Solo tickets vs follow-up pairs. A pair is case B with after=<A's id>.

    A reliability ticket that starts a follow-up pair is a head, not special.
    Otherwise the follow-up is never scheduled (Daytona KeyError / silent skip).
    """
    by_id = {c["id"]: c for c in cases}
    follow = {c["after"]: c for c in cases if c.get("after")}
    heads, solo, special = [], [], []
    for case in cases:
        if case.get("after"):
            continue
        if case["id"] in follow:
            heads.append(case)
        elif case.get("reliability"):
            special.append(case)
        else:
            solo.append(case)
    missing = [aid for aid in follow if aid not in by_id]
    if missing:
        raise SystemExit(f"follow-up after unknown ticket: {missing}")
    return solo, heads, follow, special


def bot_user():
    """The unprivileged user to run the bot as (so it cannot touch the data files), or None."""
    if os.geteuid() == 0:
        try:
            return pwd.getpwnam(BOT_USER)
        except KeyError:
            pass
    return None


def bot_command():
    return ["runuser", "-u", BOT_USER, "--", str(BOT)] if bot_user() else [str(BOT)]


def install_llm_hook(work_dir):
    """Copy the watcher where the bot user can read it; return (hook_dir, trace_dir)."""
    hook_dir, trace_dir = work_dir / "llm_hook", work_dir / "traces"
    shutil.rmtree(hook_dir, ignore_errors=True)
    shutil.copytree(LLM_HOOK, hook_dir, ignore=shutil.ignore_patterns("__pycache__"))
    trace_dir.mkdir(parents=True, exist_ok=True)
    for path in [work_dir, hook_dir, *hook_dir.iterdir(), trace_dir]:
        os.chmod(path, os.stat(path).st_mode | 0o555)
    # test.sh runs with umask 000: the folders holding the watcher must not be writable by the bot,
    # or it could swap the watcher out and hide its model calls.
    for path in [work_dir, hook_dir]:
        os.chmod(path, 0o755)
    install_hook_pth(hook_dir)
    return hook_dir, trace_dir


def install_hook_pth(hook_dir):
    """PYTHONPATH loads the watcher, but `python -I` ignores it. A .pth file in site-packages is
    still read in isolated mode, so the watcher also loads there. It only acts in processes we
    start with OBSERVE_TRACE set, and only when PYTHONPATH did not load it already."""
    try:
        site_dir = Path(sysconfig.get_paths()["purelib"])
        line = (f"import os, sys; h = {str(hook_dir)!r}; "
                "os.environ.get('OBSERVE_TRACE') and h not in sys.path and 'sitecustomize' not in sys.modules "
                "and (sys.path.insert(0, h) or __import__('sitecustomize'))\n")
        (site_dir / "observe_llm_hook.pth").write_text(line)
    except OSError:
        pass  # not root (local checks): PYTHONPATH still covers bots that run python normally


def new_trace(trace_dir, name):
    path = trace_dir / f"{name}.jsonl"
    path.write_text("")
    user = bot_user()
    if user:
        os.chown(path, user.pw_uid, user.pw_gid)
    return path


def bot_env(api_url, hook_dir, trace, prompt_cap=None):
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": "/tmp",
        "SUPPORT_API_URL": api_url,
        "BOT_MODEL": os.environ.get("BOT_MODEL", ""),
        "EMBED_MODEL": os.environ.get("EMBED_MODEL", ""),
        "PYTHONPATH": str(hook_dir),
        "OBSERVE_TRACE": str(trace),
        "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    }
    if prompt_cap:
        env["BOT_PROMPT_CAP_TOKENS"] = str(int(prompt_cap))
    for key in PROVIDER_KEYS:
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def run_bot(ticket, api_url, timeout, hook_dir, trace, prompt_cap=None):
    """Run the bot once. Returns (contract failures, stderr tail, parsed last output line or None)."""
    env = bot_env(api_url, hook_dir, trace, prompt_cap)
    try:
        proc = subprocess.Popen(
            bot_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env, cwd=str(BOT.parent), start_new_session=True,
        )
    except OSError as e:
        return [f"The bot could not be started: {e}"], "", None
    try:
        stdout, stderr = proc.communicate(json.dumps(ticket), timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        return [f"{TIMED_OUT} {timeout} seconds"], "", None
    proc = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
    if proc.returncode != 0:
        stderr = proc.stderr[-2000:] if proc.stderr else ""
        if not stderr.strip() and proc.stdout:
            stderr = "(stderr was empty; stdout tail)\n" + proc.stdout[-2000:]
        msg = f"The bot crashed (exit code {proc.returncode}); see bot_stderr_tail in results.json"
        if diagnose.llm_provider_down(stderr):
            msg = f"The bot crashed (exit code {proc.returncode}); the LLM provider did not respond"
        return [msg], stderr, None
    lines = [l for l in proc.stdout.strip().splitlines() if l.strip()]
    try:
        out = json.loads(lines[-1]) if lines else None
    except json.JSONDecodeError:
        out = None
    if not isinstance(out, dict) or out.get("ok") is not True:
        return ['The bot did not report success (its last output line must be {"ok": true, ...})'], proc.stderr[-2000:], None
    return [], proc.stderr[-2000:], out


def run_bot_watch(ticket, api_url, timeout, hook_dir, trace, data_dir, kill_after, prompt_cap=None):
    """Start the bot. If a matching write lands, kill it. Returns (failures, stderr, killed)."""
    env = bot_env(api_url, hook_dir, trace, prompt_cap)
    try:
        proc = subprocess.Popen(
            bot_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env, cwd=str(BOT.parent), start_new_session=True,
        )
    except OSError as e:
        return [f"The bot could not be started: {e}"], "", False
    try:
        proc.stdin.write(json.dumps(ticket))
    except (BrokenPipeError, OSError):
        pass
    try:
        if proc.stdin:
            proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    proc.stdin = None
    deadline = time.monotonic() + timeout
    killed = False
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        if any(
            diagnose.call_matches(r, {"call": kill_after})
            for r in load_requests(data_dir)
        ):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            killed = True
            break
        time.sleep(0.05)
    if proc.poll() is None and not killed:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        drain_proc(proc)
        return [f"{TIMED_OUT} {timeout} seconds"], "", False
    stderr = drain_proc(proc)
    if killed:
        return [], stderr[-2000:], True
    return [], stderr[-2000:], False


def drain_proc(proc, wait=5):
    """Read leftover output. stdin is already closed; do not flush it."""
    try:
        _, stderr = proc.communicate(timeout=wait)
        return stderr or ""
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass
        try:
            _, stderr = proc.communicate(timeout=2)
            return stderr or ""
        except (subprocess.TimeoutExpired, ValueError, OSError):
            return ""
    except (ValueError, OSError):
        try:
            proc.wait(timeout=wait)
        except (subprocess.TimeoutExpired, OSError):
            pass
        return ""


COLUMN_NAMES = {
    "order": "Order",
}


def show_column(value):
    if value is None:
        return "—"
    return "pass" if value else "fail"


def order_ok(requests, steps):
    """True when each listed call appears, in that order, in the HTTP log."""
    last = -1
    for spec in steps:
        spec = spec if isinstance(spec, dict) else {"call": spec}
        found = None
        for i, request in enumerate(requests):
            if i > last and diagnose.call_matches(request, spec):
                found = i
                break
        if found is None:
            return False
        last = found
    return True


def column_results(case, passed, requests, bot_problem=""):
    """End is the last ticket. Order is the only extra check; it does not change the score."""
    columns = {"end": bool(passed), "order": None}
    if bot_problem:
        return columns
    if case.get("order"):
        columns["order"] = order_ok(requests, case["order"])
    return columns


def column_scores(results):
    out = {}
    for key in COLUMN_NAMES:
        passed = total = 0
        for r in results:
            value = (r.get("columns") or {}).get(key)
            if value is None:
                continue
            total += 1
            passed += bool(value)
        if total:
            out[key] = {"passed": passed, "total": total}
    return out


def bot_reply(out):
    """The bot's message to the customer: `reply` on its last stdout line. None if it said nothing."""
    said = (out or {}).get("reply")
    if not isinstance(said, str) or not said.strip():
        return None
    return " ".join(said.split())


def timeout_message(budget, used, starts, last=None):
    """Say the whole budget and how the bot spent it, not just the time left for the last start."""
    msg = f"{TIMED_OUT} its {budget}-second budget: it ran {used:.0f}s over {starts} start{'' if starts == 1 else 's'}"
    if last is not None:
        msg += f" (the last start was stopped after {last:.0f}s)"
    return msg


def run_case(case, ctx, name):
    """The customer speaks first. After each bot exit the customer may reply again."""
    rules_by_id = ctx["rules_by_id"]
    if ctx.get("keep_state"):
        starting = load_state(ctx["data_dir"])
        if case.get("before"):
            starting = apply_before(ctx["data_dir"], case.get("before"))
    else:
        reset(ctx["data_dir"], ctx["seed_dir"])
        starting = apply_before(ctx["data_dir"], case.get("before"))
    already = len(load_requests(ctx["data_dir"]))
    trace_path = new_trace(ctx["trace_dir"], name)
    ticket = dict(case["input"])
    brief = str(case.get("customer") or "").strip()
    facts = list(case.get("facts") or [])
    behavior = case.get("behavior")
    prompt_cap = case.get("prompt_cap_tokens")
    history = []
    customer_usage = []  # each customer model call's tokens and cost
    bot_runs = []  # each start of the bot: wall-clock window and seconds (latency per customer message)
    turns = []
    customer_fault = ""
    # The bot's budget counts only time the bot itself runs, summed over its starts.
    # The customer's turns do not use it.
    budget = ctx["timeout"]
    used = 0.0
    starts = 0
    failures, stderr = [], ""
    # The bot and the customer talk only through stdin and the bot's `reply`.
    # Nothing here writes to the ticket: only the bot changes tickets, through the API.
    if brief and case.get("verbatim_opening"):
        # The ticket text is the test (e.g. an injection): send it exactly as written.
        opener = ticket["message"]
        turns.append({"reply": opener})
        history.append(("Customer", opener))
    elif brief and case.get("twin"):
        # Twins share an opening but not the answer: their first message is that opening word for word, so it never
        # tells them apart; only asking does.
        opener = brief
        turns.append({"reply": opener})
        ticket["message"] = opener
        history.append(("Customer", opener))
    elif brief:
        spoken = customer.ask(
            brief, "Send your first message to support. Use only the opening.",
            facts=facts, behavior=behavior,
        )
        customer_usage.append(spoken.get("usage"))
        if spoken.get("fault"):
            customer_fault = spoken["fault"]
        else:
            opener = spoken["reply"]
            turns.append({"reply": opener})
            ticket["message"] = opener
            history.append(("Customer", opener))
    while not customer_fault:
        remaining = int(budget - used)
        if remaining < 1:
            failures, stderr = [timeout_message(budget, used, starts)], ""
            break
        started = time.monotonic()
        run_start = time.time()
        starts += 1
        failures, stderr, out = run_bot(
            ticket, ctx["api_url"], remaining, ctx["hook_dir"], trace_path, prompt_cap,
        )
        last = time.monotonic() - started
        bot_runs.append({"start": round(run_start, 3), "end": round(time.time(), 3), "seconds": round(last, 2)})
        used += last
        if failures and failures[0].startswith(TIMED_OUT):
            failures = [timeout_message(budget, used, starts, last)]
        if failures or not brief:
            break
        said = bot_reply(out)
        if len(turns) >= customer.MAX_REPLIES or budget - used < 1:
            if said:
                turns.append({"support": [said]})
            break
        did = f"Support said: {said}" if said else "Support did not reply."
        thread = "\n\n".join([*(f"{who}: {text}" for who, text in history), did, "Reply to support."])
        if said:
            history.append(("Support", said))
        spoken = customer.ask(brief, thread, facts=facts, behavior=behavior)
        customer_usage.append(spoken.get("usage"))
        if spoken.get("fault"):
            customer_fault = spoken["fault"]
            break
        reply = spoken["reply"]
        history.append(("Customer", reply))
        turns.append({"support": [said] if said else [], "reply": reply})
        ticket["message"] = "\n\n".join(f"{who}: {text}" for who, text in history)
    state, all_requests = load_state(ctx["data_dir"]), load_requests(ctx["data_dir"])
    this_requests, requests = grade_requests(case, all_requests, already)
    if failures and (failures[0].startswith("The bot crashed") or failures[0].startswith("The bot did not report success")):
        rejected = [r for r in this_requests if r.get("status", 200) >= 400 and r.get("error")]
        if rejected:
            r = rejected[-1]
            failures[0] += f". The API rejected {r['method']} {r['path'].split('?')[0]}: {r['error']}"
    bot_problem = "; ".join(failures)
    trace = diagnose.load_trace(trace_path)
    calls = diagnose.model_calls(trace)
    if not failures:
        failures = evaluate(case, state, requests, starting, calls, model_requests=this_requests, all_requests=all_requests)
    checks = diagnose.failed_checks(case, state, requests, starting, lookup, calls, model_requests=this_requests, all_requests=all_requests) if failures and not bot_problem else []
    blame = diagnose.blame_case(case, checks, rules_by_id, calls, bot_problem, ctx.get("stored"), stderr) if failures else []
    if customer_fault:
        # The conversation could not run as written: the ticket is ours, not the bot's.
        blame = [diagnose.blame_record("customer", [], "customer fault", customer_fault)]
    passed = not failures
    columns = column_results(case, passed, requests, bot_problem)
    return {
        "id": case["id"],
        "group": case.get("group", "normal"),
        **case_behavior_meta(case),
        "title": case.get("title", ""),
        "rules": case["rules"],
        "passed": passed,
        "columns": columns,
        "failures": failures,
        "bot_problem": bot_problem,
        "observed": observe(case, state, requests, starting, calls, model_requests=this_requests),
        "diff": outcome_diff(case, state, requests, starting, calls, model_requests=this_requests),
        "checks": checks,
        "blame": blame,
        "change_sources": diagnose.change_sources(this_requests, calls) if calls is not None else [],
        "requests": requests,
        "model_calls": calls,
        "bot_runs": bot_runs,
        # Tokens and cost of this ticket's model calls: the bot's (from the LLM watcher) and the customer model's.
        "usage": {"bot": observe_usage.add(*[c.get("usage") for c in calls]), "customer": observe_usage.add(*customer_usage)},
        "trace": trace,
        "bot_stderr_tail": stderr,
        "customer_turns": turns,
        "conversation": ticket.get("message") or "",
        "customer_fault": customer_fault,
        "prompt_cap_tokens": prompt_cap,
    }


def cmd_run(args):
    global BOT, SERVER
    BOT, SERVER = Path(args.bot), Path(args.server)
    cases = pack_cases(load_json(args.cases))
    rules = load_json(args.rules)
    seed_dir = Path(args.seed)
    data_dir = Path(args.data)
    logs = Path(args.logs)
    logs.mkdir(parents=True, exist_ok=True)

    bot_files = diagnose.snapshot_bot(BOT.parent, logs / "bot")
    self_report = diagnose.load_self_report(BOT.parent / "ARCHITECTURE.json")
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(data_dir, 0o700)
    work_root = data_dir / "work"
    work_root.mkdir(parents=True, exist_ok=True)
    os.chmod(work_root, 0o700)
    work = data_dir.parent / "observe"
    hook_dir, trace_dir = install_llm_hook(work)
    baseline = diagnose.baseline_imports(hook_dir, trace_dir / "_baseline.jsonl")
    ensure_bot_writable(BOT.parent)
    workers = getattr(args, "workers", WORKERS)
    solo, heads, follow, special = split_cases(cases)
    backend = _ticket_backend()
    print(f"Running {len(cases)} tickets via {backend}, {workers} at a time"
          + (f", {len(heads)} follow-up pair(s)" if heads else "")
          + (f", {len(special)} reliability ticket(s)" if special else "")
          + ".")
    base = {
        "work_root": work_root, "seed_dir": seed_dir, "seed": load_state(seed_dir),
        "trace_dir": trace_dir, "hook_dir": hook_dir, "timeout": args.bot_timeout,
        "app": args.app,
        "rules_by_id": {r["id"]: r for r in rules},
        "stored": diagnose.stored_corpus(BOT.parent),
        "bot_path": BOT,
        "server_path": SERVER,
    }
    # Daytona: solos + reliability tickets each get their own sandbox, so fan out together.
    # Local: reliability tickets stay sequential after solos (they mutate the shared bot tree).
    first_wave = solo + (special if backend == "daytona" else [])
    got = run_pool([(case, case["id"]) for case in first_wave], base, workers)
    got.update(run_pairs(heads, follow, base, workers))
    if backend != "daytona":
        for case in special:
            try:
                r = run_sandboxed(case, base, case["id"])
            except Exception as exc:
                r = crashed_result(case, exc)
            got[case["id"]] = r
            print_ticket(r)
    results = [got[case["id"]] for case in cases]
    finish(results, cases, rules, BOT.parent, logs, baseline, self_report, bot_files, trace_dir)


def finish(results, cases, rules, bot_dir, logs, baseline, self_report, bot_files, trace_dir=None):
    """Score a stage from its ticket results and write results.json, architecture.json, scores.json,
    reward.txt and report.md."""
    card = diagnose.architecture_card(results, baseline, str(bot_dir))
    prompts = diagnose.prompt_corpus([c for r in results for c in r["model_calls"]])
    handoff_needed = any("/handoffs" in json.dumps(c.get("required_calls", [])) for c in cases)
    claims = diagnose.check_self_report(self_report, card, str(bot_dir), prompts, handoff_needed)
    if trace_dir is not None:
        for r in results:
            # Tickets run in their own sandbox bring their trace back in the result.
            path = trace_dir / f"{r['id']}.jsonl"
            if r.get("trace") and not path.exists():
                path.write_text("".join(json.dumps(e) + "\n" for e in r["trace"]))
        shutil.copytree(trace_dir, logs / "traces", dirs_exist_ok=True)
    for r in results:
        r.pop("trace", None)
    # Every ticket counts. Tickets that went wrong only because of us are reported, not dropped.
    counted = results
    ours = sum(ours_only(r) for r in results)
    passed = sum(r["passed"] for r in counted)
    # Harbor headline stays the flat ticket pass rate so in-flight / older
    # stages keep a comparable reward. Behavior coverage metrics are reported
    # separately when cases carry scenario/category/realization fields.
    reward = passed / len(counted) if counted else 0.0
    # Only rules a ticket in this stage tests ("rules we test" in the report).
    tested = {rid for c in cases for rid in c.get("rules", [])}
    subset = diagnose.subset_summary([r for r in rules if r["id"] in tested], bot_dir, prompts)
    context = diagnose.context_summary(results, {r["id"]: r for r in rules})
    # Doc recall is not part of the published results (the fact judge's run copy drops it), so it is not computed.
    docs = None
    coverage = behavior_coverage_scores(counted)
    realization = realization_scores(counted)
    attribution = behavior_attribution(counted)
    knowledge_condition = os.environ.get("KNOWLEDGE_CONDITION") or os.environ.get("STAGE")
    cost = cost_summary(results)
    scores = {"tickets": {"passed": passed, "total": len(counted), "ours": ours},
              "by_group": group_scores(counted),
              "columns": column_scores(counted),
              "self_report": {"right": claims["right"], "checked": claims["checked"]},
              "changes_not_from_model": card["changes_not_from_model"],
              "change_sources": diagnose.source_summary(counted),
              "subset": subset,
              "context": context}
    if coverage:
        scores["behavior_coverage"] = coverage
    if realization:
        scores["realization_robustness"] = realization
    if attribution:
        scores["behavior_attribution"] = attribution
    ka = diagnose.knowledge_application_summary(counted, subset)
    scores["knowledge_application"] = ka
    if knowledge_condition:
        scores["knowledge_condition"] = knowledge_condition
        scores["Qk"] = reward
    if docs:
        scores["docs"] = {k: v for k, v in docs.items()}
    info = info_summary(counted, cases)
    if info:
        scores["info"] = info
    if cost:
        scores["cost"] = cost
    (logs / "results.json").write_text(json.dumps(results, indent=2))
    (logs / "architecture.json").write_text(json.dumps({"observed": card, "self_report": claims, "subset": subset, "context": context}, indent=2))
    (logs / "scores.json").write_text(json.dumps(scores, indent=2))
    (logs / "reward.txt").write_text(f"{reward:.4f}\n")
    (logs / "report.md").write_text(render_report(results, cases, card, bot_files, claims, subset, context, coverage, realization,
                                                       attribution, knowledge_condition=knowledge_condition, qk=reward, docs=docs,
                                                       info=info))
    cond = f" [{knowledge_condition}]" if knowledge_condition else ""
    if docs and docs.get("tickets"):
        print(f"Docs reached: recall {docs['recall']}, precision {docs['precision']} over {docs['tickets']} tickets")
    print(f"\n{passed}/{len(counted)} cases passed, reward {reward:.4f}{cond}" + (f" ({ours} failed because of us)" if ours else ""))
    if coverage:
        print(f"Qcoverage {coverage['q_coverage']:.4f} across {coverage['n_scenarios']} scenarios")
    if attribution:
        print(f"Behaviour failures {attribution['behavior_failures']}, doc failures {attribution['doc_failures']}")
    if realization and realization.get("mean_q_realization") is not None:
        print(f"Mean Qrealization {realization['mean_q_realization']:.4f}")
    print(f"Readable report: {logs / 'report.md'}")


def cmd_run_one(args):
    """Worker entrypoint: one ticket or one follow-up pair. Writes JSON results and exits."""
    global BOT, SERVER
    BOT, SERVER = Path(args.bot), Path(args.server)
    cases = pack_cases(load_json(args.cases))  # no-op when cmd_run already applied it
    by_id = {c["id"]: c for c in cases}
    rules = load_json(args.rules)
    seed_dir = Path(args.seed)
    data_dir = Path(args.data)
    logs = Path(args.logs)
    logs.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(data_dir, 0o700)
    work_root = data_dir / "work"
    work_root.mkdir(parents=True, exist_ok=True)
    os.chmod(work_root, 0o700)
    work = data_dir.parent / "observe"
    hook_dir, trace_dir = install_llm_hook(work)
    base = {
        "work_root": work_root, "seed_dir": seed_dir, "seed": load_state(seed_dir),
        "trace_dir": trace_dir, "hook_dir": hook_dir, "timeout": args.bot_timeout,
        "app": args.app,
        "rules_by_id": {r["id"]: r for r in rules},
        "stored": diagnose.stored_corpus(BOT.parent),
        "bot_path": BOT,
        "server_path": SERVER,
    }
    # Always in-process inside a ticket sandbox (or a local run-one debug).
    os.environ["TICKET_SANDBOX"] = "local"
    if args.pair_head:
        if args.pair_head not in by_id:
            raise SystemExit(f"unknown pair head: {args.pair_head}")
        follow = {c["after"]: c for c in cases if c.get("after")}
        head = by_id[args.pair_head]
        if head["id"] not in follow:
            raise SystemExit(f"no follow-up after {args.pair_head}")
        ensure_bot_writable(BOT.parent)
        got = run_chain(head, follow[head["id"]], base)
    else:
        if not args.case_id or args.case_id not in by_id:
            raise SystemExit(f"unknown case id: {args.case_id}")
        case = by_id[args.case_id]
        ensure_bot_writable(BOT.parent)
        key = case["id"]
        try:
            r = run_sandboxed(case, base, case["id"])
        except Exception as exc:
            r = crashed_result(case, exc)
        got = {key: r}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # LLM events are already in model_calls; keep the rest (imports, files, programs, embeddings)
    # so the orchestrator can build the architecture card.
    for r in got.values():
        r["trace"] = [e for e in r.get("trace") or [] if isinstance(e, dict) and e.get("kind") != "llm"]
    out.write_text(json.dumps({"results": got}, indent=2))
    print(f"Wrote {out} ({len(got)} result(s))")


SHORT_FIELDS = {
    "priority": "urgency",
    "first_response_target": "reply time",
    "escalation_status": "escalation",
    "assigned_team": "team",
    "needs_legal_review": "legal review",
    "labels": "labels",
    "status": "status",
}
SHORT_CALLS = {"POST /credits": "give a credit", "POST /api_keys/*/disable": "disable a key", "POST /handoffs": "hand off to a person"}


def observe(case, state, requests, seed, model_calls=None, model_requests=None):
    """What the bot actually left behind, for every field the case checks, and changes the model never said."""
    writes = requests if model_requests is None else model_requests
    paths = list(case.get("expect", {})) + list(case.get("unknown_fields", [])) + list(case.get("contains", {})) + \
        list(case.get("not_contains", {}))
    observed = {}
    for path in dict.fromkeys(paths):
        found, got = lookup(state, path)
        observed[path] = got if found else None
    calls = sorted({
        f"{r['method']} {r['path'].split('?')[0]}"
        for pattern in case.get("forbidden_calls", [])
        for r in requests
        if fnmatch.fnmatchcase(f"{r['method']} {r['path'].split('?')[0]}", pattern)
    })
    changed = [f for f in case.get("unchanged", []) if state.get(f) != seed.get(f)]
    missing = [spec for spec in case.get("required_calls", []) if not any(diagnose.call_matches(r, spec) for r in requests)]
    not_asked = diagnose.not_from_model(writes, model_calls) if model_calls is not None else []
    return {"fields": observed, "forbidden_calls_made": calls, "changed_files": changed, "required_calls_missing": missing,
            "not_from_model": not_asked}


def short_name(path):
    file, record_id, field = path.split(".", 2)
    return f"key {record_id}" if file == "api_keys" else SHORT_FIELDS.get(field, field)


def show(value):
    if isinstance(value, list):
        return ", ".join(value) if value else "none"
    if isinstance(value, bool):
        return "yes" if value else "no"
    return "not set" if value is None else str(value)


def outcome_diff(case, state, requests, seed, model_calls=None, model_requests=None):
    """Every check as a diff line: '  ' = bot got it right, '- ' = what the bot did, '+ ' = what was correct."""
    writes = requests if model_requests is None else model_requests
    lines = []
    for path, want in case.get("expect", {}).items():
        found, got = lookup(state, path)
        got = got if found else None
        if got == want:
            lines.append(f"  {short_name(path)}: {show(got)}")
        else:
            lines += [f"- {short_name(path)}: {show(got)}", f"+ {short_name(path)}: {show(want)}"]
    for path in case.get("unknown_fields", []):  # the pack's docs do not decide it (pack_cases)
        found, got = lookup(state, path)
        was = lookup(seed, path)[1]
        if not found or got is None or got == was:
            lines.append(f"  {short_name(path)}: {show(was)} (left as it was: these docs do not say)")
        else:
            lines += [f"- {short_name(path)}: {show(got)}", f"+ {short_name(path)}: left as it was, or hand off (these docs do not say)"]
    for key, verb in (("contains", "must include"), ("not_contains", "must not include")):
        for path, values in case.get(key, {}).items():
            found, got = lookup(state, path)
            got = got if found and isinstance(got, list) else []
            wrong = [v for v in values if (v in got) == (key == "not_contains")]
            if wrong:
                lines += [f"- {short_name(path)}: {show(got)}", f"+ {short_name(path)} {verb}: {show(wrong)}"]
            else:
                lines.append(f"  {short_name(path)} {verb}: {show(values)}")
    for file in case.get("unchanged", []):
        if state.get(file) != seed.get(file):
            lines += [f"- changed {FILE_NAMES.get(file, file)}", f"+ {FILE_NAMES.get(file, file)} left untouched"]
    for pattern in case.get("forbidden_calls", []):
        made = sorted({call_of(r) for r in requests if fnmatch.fnmatchcase(call_of(r), pattern)})
        what = SHORT_CALLS.get(pattern, pattern)
        if made:
            lines += [f"- did {what} ({', '.join(made)})", f"+ must not {what}"]
        else:
            lines.append(f"  did not {what}")
    for spec in case.get("required_calls", []):
        what = SHORT_CALLS.get(spec["call"], spec["call"])
        want = body_text(spec.get("body"))
        if any(diagnose.call_matches(r, spec) for r in requests):
            lines.append(f"  did {what} ({want})")
        else:
            made = [r for r in requests if fnmatch.fnmatchcase(call_of(r), spec["call"])]
            did = "; ".join(f"did {what} ({body_text(r.get('body'))})" for r in made) or f"did not {what}"
            lines += [f"- {did}", f"+ {what} ({want})"]
    return lines


def call_of(request):
    return f"{request['method']} {request['path'].split('?')[0]}"


def clip(text, limit):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + " …"


def action_text(request):
    call, body = call_of(request), request.get("body") or {}
    if request["path"].endswith("/comments"):
        text = f"{call}: wrote \"{clip(body.get('body', ''), 200)}\""
    elif body:
        text = f"{call}: " + ", ".join(f"{k}={show(v)}" for k, v in body.items())
    else:
        text = call
    status = request.get("status", 200)
    return text if status < 400 else f"{text} (rejected by the system, {status})"


def message_text(message):
    if not isinstance(message, dict):
        return "?", clip(message, 400)
    content = message.get("content")
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    text = clip(content or "", 400)
    for call in message.get("tool_calls") or []:
        fn = call.get("function", call) if isinstance(call, dict) else {}
        text += f" [asks to run {fn.get('name')}({clip(fn.get('arguments', ''), 150)})]"
    return message.get("role", "?"), text.strip()


def conversation_lines(calls):
    """Each model call, showing only the messages that are new since the previous call."""
    lines, previous = [], []
    for i, call in enumerate(calls, 1):
        messages = call.get("messages") or []
        new = messages[len(previous):] if messages[:len(previous)] == previous else messages
        previous = messages
        lines.append(f"**Call {i}** · {call.get('model')} · {call.get('seconds', '?')}s")
        lines.append("")
        for message in new:
            role, text = message_text(message)
            lines.append(f"> **{role}:** {text}")
            lines.append(">")
        if call.get("error"):
            lines.append(f"> **model error:** {clip(call['error'], 300)}")
        else:
            _, text = message_text({"content": call["reply"].get("content"), "tool_calls": [
                {"name": t["name"], "arguments": t["arguments"]} for t in call["reply"].get("tool_calls", [])
            ]})
            lines.append(f"> **model replied:** {text or '(empty)'}")
        lines.append("")
    return lines


def singular(name, values):
    return name[:-1] if len(values) == 1 and name.endswith("s") else name


def what_happened(case, r):
    """One short plain sentence describing the result."""
    if r["passed"]:
        return "Bot got everything right."
    if r.get("bot_problem"):
        return r["bot_problem"] + "."
    observed = r.get("observed")
    if not observed:
        return "; ".join(r["failures"]) + "."
    fields, parts = observed["fields"], []
    for path, want in case.get("expect", {}).items():
        got = fields.get(path)
        if got is None:
            parts.append(f"did not set {short_name(path)} (should be {show(want)})")
        elif got != want:
            parts.append(f"set {short_name(path)} to {show(got)} instead of {show(want)}")
    for path, values in case.get("contains", {}).items():
        missing = [v for v in values if v not in (fields.get(path) or [])]
        if missing:
            parts.append(f"missed {singular(short_name(path), missing)} {show(missing)}")
    for path, values in case.get("not_contains", {}).items():
        extra = [v for v in values if v in (fields.get(path) or [])]
        if extra:
            parts.append(f"added {singular(short_name(path), extra)} {show(extra)}, which should not be there")
    for file in observed["changed_files"]:
        parts.append(f"changed {FILE_NAMES.get(file, file)}, which must stay untouched")
    for call in observed["forbidden_calls_made"]:
        parts.append(CALL_NAMES.get(call, f"did a forbidden action ({call})"))
    for spec in observed.get("required_calls_missing", []):
        parts.append(f"did not {SHORT_CALLS.get(spec['call'], spec['call'])} ({body_text(spec.get('body'))})")
    return ("Bot " + "; ".join(parts) + ".") if parts else "; ".join(r["failures"]) + "."


def side_of(b):
    return b.get("side") or diagnose.BLAME_SIDE.get(b["blame"], diagnose.BOT)


def ours_only(r):
    """True when a ticket went wrong only because of us (customer model failed, provider down, our time limit).
    Every ticket still counts in the score; these are shown as failed because of us."""
    if r.get("passed"):
        return False
    if r.get("customer_fault"):
        return True
    blame = r.get("blame") or []
    return bool(blame) and all(side_of(b) == diagnose.US for b in blame)


def blame_labels(r):
    return list(dict.fromkeys(f"{side_of(b)}: {b['blame']}" for b in r.get("blame", [])))


def blame_sentence(r):
    parts = []
    for b in r.get("blame", []):
        text = f"**{side_of(b).capitalize()}**: {diagnose.BLAME_TEXT[b['blame']]}"
        detail = b.get("detail") if b["blame"] != "crashed" else ""
        detail = f" ({detail or 'rule ' + ', '.join(b.get('rules', []))})" if detail or b.get("rules") else ""
        if text + detail not in parts:
            parts.append(text + detail)
    return "; ".join(parts)


def blame_summary(results):
    counts = {}
    for r in results:
        for label in blame_labels(r):
            counts[label] = counts.get(label, 0) + 1
    us = sum(v for k, v in counts.items() if k.startswith(diagnose.US + ":") or k == diagnose.US)
    builder = sum(v for k, v in counts.items() if k.startswith(diagnose.BUILDER))
    bot = sum(v for k, v in counts.items() if k.startswith(diagnose.BOT))
    detail = ", ".join(f"{k.split(': ', 1)[1]} {v}" for k, v in sorted(counts.items()))
    extra = f", us {us} (counted as wrong)" if us else ""
    return f"**Who made the mistakes:** builder {builder}, bot {bot}{extra}" + (f" ({detail})" if detail else "")


GROUP_ORDER = [
    "normal", "handoff", "bad-actor", "changed-rule", "new-rule", "unchanged",
    "missing_info", "ambiguous", "conflict", "escalate", "linguistic",
]

CATEGORY_ORDER = [
    "normal", "missing_info", "ambiguous", "conflict", "escalate",
    "exception", "boundary",
]


def _pass_rate(passed, total):
    return (passed / total) if total else 0.0


def scenario_cells(results):
    """Group counted results into x = (scenario, category) with realization list U(x)."""
    cells = {}
    for r in results:
        scenario = r.get("scenario")
        if not scenario:
            continue
        category = r.get("category") or r.get("group") or "normal"
        key = (scenario, category)
        cell = cells.setdefault(key, {
            "scenario": scenario,
            "category": category,
            "realizations": [],
            "passed": 0,
            "total": 0,
        })
        cell["realizations"].append({
            "id": r["id"],
            "realization": r.get("realization") or "base",
            "behavior": r.get("behavior") or category,
            "passed": bool(r["passed"]),
        })
        cell["total"] += 1
        cell["passed"] += int(bool(r["passed"]))
    for cell in cells.values():
        # q(A, x, S) = mean over realizations U(x)
        cell["q"] = _pass_rate(cell["passed"], cell["total"])
    return cells


def behavior_coverage_scores(results):
    """Qcoverage over X(S), plus per-category breakdown.

    x = (scenario, category). q(A,x,S) averages realizations of that cell.
    Qcoverage uses uniform weights over scenarios x (wx = 1).
    """
    cells = scenario_cells(results)
    if not cells:
        return None
    scenarios = sorted(cells.values(), key=lambda c: (c["scenario"], c["category"]))
    q_coverage = sum(c["q"] for c in scenarios) / len(scenarios)
    by_category = {}
    for cell in scenarios:
        cat = by_category.setdefault(cell["category"], {
            "scenarios": 0, "passed": 0, "total": 0, "q_sum": 0.0,
        })
        cat["scenarios"] += 1
        cat["passed"] += cell["passed"]
        cat["total"] += cell["total"]
        cat["q_sum"] += cell["q"]
    for row in by_category.values():
        row["q"] = row["q_sum"] / row["scenarios"] if row["scenarios"] else 0.0
        del row["q_sum"]
    return {
        "q_coverage": q_coverage,
        "weights": "uniform_scenario",
        "n_scenarios": len(scenarios),
        "by_category": by_category,
        "by_scenario": [
            {
                "scenario": c["scenario"],
                "category": c["category"],
                "q": c["q"],
                "passed": c["passed"],
                "total": c["total"],
            }
            for c in scenarios
        ],
    }


def realization_scores(results):
    """Qrealization(x) = Eu~U(x)[q(A,u,S)] for cells with surface variants.

    Reports every scenario cell; mean_q_realization averages only cells with
    |U(x)| > 1 so single-ticket categories do not dominate robustness.
    """
    cells = scenario_cells(results)
    if not cells:
        return None
    by_scenario = []
    multi = []
    for key in sorted(cells):
        cell = cells[key]
        entry = {
            "scenario": cell["scenario"],
            "category": cell["category"],
            "q_realization": cell["q"],
            "n_realizations": cell["total"],
            "realizations": cell["realizations"],
        }
        by_scenario.append(entry)
        if cell["total"] > 1:
            multi.append(cell["q"])
    return {
        "by_scenario": by_scenario,
        "mean_q_realization": (sum(multi) / len(multi)) if multi else None,
        "n_multi_realization_scenarios": len(multi),
    }


def group_scores(results):
    out = {}
    for r in results:
        g = out.setdefault(r.get("group", "normal"), {"passed": 0, "total": 0})
        g["total"] += 1
        g["passed"] += r["passed"]
    return out


def group_lines(results):
    lines = ["## By ticket type", "",
             "End broken down by kind. Same score as the headline.", "",
             "| Type | Passed |", "| --- | --- |"]
    groups = group_scores(results)
    for group in GROUP_ORDER:
        if group in groups:
            g = groups[group]
            lines.append(f"| {GROUP_NAMES.get(group, group)} | {g['passed']} / {g['total']} |")
    for group, g in groups.items():
        if group not in GROUP_ORDER:
            lines.append(f"| {GROUP_NAMES.get(group, group)} | {g['passed']} / {g['total']} |")
    cols = column_scores(results)
    if cols.get("order"):
        g = cols["order"]
        lines += ["", f"Order (same run, not in the score): {g['passed']} / {g['total']}."]
    return lines + [""]


BOT_ERRORS = ("crashed", "context overflow", "no model call", "model call failed")


def run_owner(r):
    """Who is to blame when a ticket tested no rule: "us" (our time limit, provider, customer
    model), "bot" (it crashed or never made a working model call), or None when it really ran."""
    if r.get("passed"):
        return None
    if ours_only(r):
        return "us"
    if any(b.get("blame") in BOT_ERRORS for b in r.get("blame") or []) or r.get("bot_problem"):
        return "bot"
    return None


def behavior_attribution(results):
    """Per scenario, compare each behaviour ticket with the scenario's normal ticket (the control).

    Same bot, same docs, same stage. Every failed variant gets one bucket:
      ours              the variant or the control went wrong only because of us (time limit,
                        provider, customer model): side "us";
      bot_errors        the variant or the control crashed or made no working model call: side "bot",
                        but no rule was tested;
      behavior_failures the control passed, this variant failed: side "bot";
      doc_failures      the control failed on a rule too (its blame says builder or bot);
      no_control        this variant failed on a rule, but the control lost to us or a bot error.
    Passed variants are "handled" (control passed) or "noisy" (control failed)."""
    scenarios = {}
    for r in results:
        if r.get("scenario"):
            scenarios.setdefault(r["scenario"], []).append(r)
    if not scenarios:
        return None
    kinds = ("behavior_failures", "doc_failures", "no_control", "ours", "bot_errors", "handled", "noisy")
    out = {**{k: 0 for k in kinds}, "by_behavior": {}, "by_scenario": []}
    for scenario, rows in sorted(scenarios.items()):
        control = next((r for r in rows if r.get("category") == "normal" and r.get("realization", "base") == "base"), None)
        if control is None:
            continue
        control_owner = run_owner(control)
        row = {"scenario": scenario, "control": control["id"], "control_passed": control["passed"],
               "control_owner": control_owner, **{k: [] for k in kinds}}
        for r in rows:
            if r is control:
                continue
            owner = run_owner(r)
            if owner == "us":
                kind = "ours"
            elif owner == "bot":
                kind = "bot_errors"
            elif not r["passed"] and control_owner:
                # Failed on a rule, but the control never really ran: behaviour vs docs cannot be told.
                kind = "no_control"
            elif control["passed"] or (r["passed"] and control_owner):
                # A passing variant is handled; "noisy" is only for a control that failed on a rule.
                kind = "handled" if r["passed"] else "behavior_failures"
            else:
                kind = "noisy" if r["passed"] else "doc_failures"
            row[kind].append(r["id"])
            b = out["by_behavior"].setdefault(r.get("behavior") or r.get("category"),
                                              {"tickets": 0, "behavior_failures": 0, "doc_failures": 0, "no_control": 0,
                                               "ours": 0, "bot_errors": 0})
            b["tickets"] += 1
            if kind in b:
                b[kind] += 1
        for kind in kinds:
            out[kind] += len(row[kind])
        out["by_scenario"].append(row)
    return out if out["by_scenario"] else None


def attribution_lines(attribution):
    if not attribution:
        return []
    lines = ["## Behaviour or docs?", "",
             "Each scenario's normal ticket is the control (same bot, same docs). A variant that fails while "
             "the control passes is a behaviour failure; if the control fails on a rule too, the rule itself was "
             "missed (doc failure). Failures caused only by us (time limit, provider, customer model) and bot "
             "errors where no rule was tested (crash, no model call) are counted apart.", "",
             f"Behaviour failures (bot): {attribution['behavior_failures']} · doc failures: {attribution['doc_failures']} · "
             f"ours (us): {attribution['ours']} · bot errors, no rule tested (bot): {attribution['bot_errors']} · "
             f"handled: {attribution['handled']} · control failed but variant passed: {attribution['noisy']}", "",
             "| Scenario | Control | Behaviour failures | Doc failures | Ours | Bot errors |",
             "| --- | --- | --- | --- | --- | --- |"]
    for row in attribution["by_scenario"]:
        control = "passed" if row["control_passed"] else {"us": "failed (us)", "bot": "failed (bot error)"}.get(
            row["control_owner"], "failed")
        cells = [", ".join(row[k]) or "—" for k in ("behavior_failures", "doc_failures", "ours", "bot_errors")]
        lines.append(f"| {row['scenario']} | {control} | " + " | ".join(cells) + " |")
    return lines + [""]


def coverage_lines(coverage, realization):
    """Report Qcoverage and Qrealization when the case set carries scenario tags."""
    if not coverage:
        return []
    lines = [
        "## Behavioral coverage",
        "",
        "Each stage has one behaviour scenario: same docs, only user behavior varies. "
        "Each scenario x is a `(scenario, category)` cell. "
        "`q(A,x,S)` averages its surface realizations; "
        "`Qcoverage` is the uniform mean over those scenarios.",
        "",
        f"**Qcoverage:** {coverage['q_coverage']:.4f} "
        f"({coverage['n_scenarios']} scenarios, weights={coverage['weights']})",
        "",
        "| Category | Scenarios | Tickets passed | q |",
        "| --- | --- | --- | --- |",
    ]
    by_cat = coverage.get("by_category") or {}
    for cat in CATEGORY_ORDER:
        if cat not in by_cat:
            continue
        row = by_cat[cat]
        lines.append(
            f"| {GROUP_NAMES.get(cat, cat)} | {row['scenarios']} | "
            f"{row['passed']} / {row['total']} | {row['q']:.4f} |"
        )
    for cat, row in by_cat.items():
        if cat in CATEGORY_ORDER:
            continue
        lines.append(
            f"| {GROUP_NAMES.get(cat, cat)} | {row['scenarios']} | "
            f"{row['passed']} / {row['total']} | {row['q']:.4f} |"
        )
    lines += ["", "| Scenario | Category | q(A,x,S) |", "| --- | --- | --- |"]
    for row in coverage.get("by_scenario") or []:
        lines.append(
            f"| {row['scenario']} | {GROUP_NAMES.get(row['category'], row['category'])} | "
            f"{row['q']:.4f} |"
        )
    lines.append("")
    if realization:
        mean_q = realization.get("mean_q_realization")
        lines += [
            "## Realization robustness",
            "",
            "Same underlying scenario, different surface forms `U(x)`. "
            "`Qrealization(x)` is the mean over those forms.",
            "",
        ]
        if mean_q is None:
            lines.append("No scenario has more than one surface realization yet.")
        else:
            lines.append(
                f"**Mean Qrealization** (cells with |U(x)| > 1): {mean_q:.4f} "
                f"across {realization['n_multi_realization_scenarios']} scenario cells."
            )
        lines += ["", "| Scenario | Category | |U(x)| | Qrealization |", "| --- | --- | --- | --- |"]
        for row in realization.get("by_scenario") or []:
            lines.append(
                f"| {row['scenario']} | {GROUP_NAMES.get(row['category'], row['category'])} | "
                f"{row['n_realizations']} | {row['q_realization']:.4f} |"
            )
        lines.append("")
    return lines


def design_text(claims):
    design = claims.get("design") or {}
    labels = [
        ("architecture_choice", "Architecture choice"),
        ("how_it_works", "How it works"),
        ("parts", "Parts"),
        ("how_docs_reach_the_model", "How the docs reach the model"),
        ("memory", "Memory"),
    ]
    lines = [""]
    for key, label in labels:
        text = design.get(key) or "not stated"
        lines.append(f"**{label}:** {text}")
    return lines


def claim_lines(claims):
    lines = ["## What the builder says it built (checked against what was seen)", ""]
    if not claims["given"]:
        return lines + [f"**No valid self-report:** {claims['error']}.", ""]
    lines += [f"**Claims that match:** {claims['right']} / {claims['checked']}", ""]
    if claims.get("summary"):
        lines += [f"> {clip(claims['summary'], 600)}", ""]
    lines += ["| Claim | Builder said | Watcher saw | Match |", "| --- | --- | --- | --- |"]
    for c in claims["claims"]:
        said, saw = (show(c["said"]) if isinstance(c["said"], bool) else c["said"]), (show(c["saw"]) if isinstance(c["saw"], bool) else c["saw"])
        lines.append(f"| {c['claim'].removeprefix('agent.').replace('_', ' ')} | {said} | {saw} | {'yes' if c['ok'] else '**NO**'} |")
    lines += design_text(claims)
    return lines + [""]


def card_lines(card, bot_files):
    c = card
    rows = [
        ("Model calls per ticket", f"{c['model_calls_per_ticket']['avg']} (min {c['model_calls_per_ticket']['min']}, max {c['model_calls_per_ticket']['max']})"),
        ("Model calls per bot run", f"{c['model_calls_per_run']['avg']} (max {c['model_calls_per_run']['max']})" if c.get("model_calls_per_run") else "–"),
        ("Model", ", ".join(c["models"]) or "none"),
        ("Prompt size per call", f"about {c['prompt_chars_per_call']['avg'] // 4:,} tokens (max {c['prompt_chars_per_call']['max'] // 4:,})"),
        ("Different system prompts", str(c["distinct_system_prompts"])),
        ("Tools given to the model", ", ".join(c["tools_offered_to_model"]) or "none"),
        ("Embedding calls", str(c["embedding_calls"])),
        ("Bot data files read", ", ".join(c["bot_data_files_read"][:10]) or "none"),
        ("Extra libraries", ", ".join(c["extra_libraries"]) or "none"),
        ("Programs started", ", ".join(c["programs_started"]) or "none"),
        ("Handoffs to a person", str(c["handoffs_made"])),
        ("Files written while running", ", ".join(c["files_written"][:5]) or "none"),
        ("Python processes per ticket", str(c["python_processes_per_ticket"])),
        ("Changes the model never said", str(c["changes_not_from_model"])),
        ("Who decided the changes", c.get("change_split", "none")),
    ]
    lines = ["## How the bot is built (observed while it ran)", "", "| What | Observed |", "| --- | --- |"]
    lines += [f"| {k} | {v} |" for k, v in rows]
    lines += ["", f"**Bot code** ({len(bot_files)} files, saved in `bot/` next to this report):", ""]
    lines += [f"- `{p}` ({size})" for p, size in bot_files[:30]]
    if len(bot_files) > 30:
        lines.append(f"- … and {len(bot_files) - 30} more")
    return lines + [""]


def subset_lines(subset):
    if not subset:
        return []
    kept, total, reached = subset["kept"], subset["rules"], subset["reached"]
    unseen = subset.get("kept_not_reached", kept - reached)
    missing = total - kept
    lines = [
        "## Docs the bot kept",
        "",
        "While a ticket is being handled, the bot cannot open the company docs. It can only use the copy the builder saved inside it beforehand.",
        "",
    ]
    if total:
        if kept == total:
            lines.append(f"**Every rule was saved.** All {total} rules we test have their sentence stored in the bot's files. The builder did not leave one out.")
        else:
            lines.append(f"**{kept} of {total} rules were saved.** {missing} of the rules we test are not in the bot's files. The builder never stored them.")
        lines.append("")
        if not kept:
            lines.append("**The model saw none of the rules,** because none were saved.")
        elif not unseen:
            lines.append(f"**The model saw every saved rule.** All {reached} showed up in a prompt while the tickets were handled.")
        else:
            word = "was" if unseen == 1 else "were"
            lines.append(f"**The model saw {reached} of {total} rules.** {unseen} {word} saved in the bot but never shown to the model on these tickets.")
        lines.append("")
    return lines


def context_lines(context):
    if not context:
        return []
    lines = [
        "## Prompt window on capped tickets",
        "",
        "These tickets refuse a bot call over the cap. The Harbor score is still the desk. This table is the note.",
        "",
        "| Ticket | Cap | Largest call | Right sentence | Cousin | Desk |",
        "| --- | ---: | ---: | --- | --- | --- |",
    ]
    for row in context:
        lines.append(
            f"| {row['id']} | {row['cap']} | {row['max_tokens']} | "
            f"{'in' if row['right'] else 'out'} | "
            f"{'in' if row['cousin'] else 'out'} | "
            f"{'pass' if row['passed'] else 'fail'} |"
        )
    return lines + [""]


def fault_names(r):
    if r.get("customer_fault"):
        return "Us"
    if r["passed"]:
        names = list(dict.fromkeys(side_of(b).capitalize() for b in r.get("blame", []) if b.get("blame") == "no tools"))
        return ", ".join(names)
    if ours_only(r):
        return "Us"
    names = list(dict.fromkeys(side_of(b).capitalize() for b in r.get("blame", [])))
    return ", ".join(names)


def tool_errors(r):
    reasons = []
    for call in r.get("model_calls") or []:
        for message in call.get("messages") or []:
            if not isinstance(message, dict) or message.get("role") != "tool":
                continue
            try:
                err = json.loads(message.get("content") or "").get("error")
            except (json.JSONDecodeError, AttributeError, TypeError):
                continue
            if not isinstance(err, str) or not err:
                continue
            text = err
            if text not in reasons:
                reasons.append(text)
    return reasons


def last_tool_args(r):
    """The last change the model asked for: tool name and its arguments."""
    name, args = "", None
    for call in r.get("model_calls") or []:
        for tool in (call.get("reply") or {}).get("tool_calls") or []:
            if tool.get("name") not in ("update_ticket", "create_handoff", "disable_api_key", "post_credit"):
                continue
            raw = tool.get("arguments")
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except json.JSONDecodeError:
                    raw = {}
            if isinstance(raw, dict):
                name, args = tool.get("name") or "", raw
    return name, args


def saved_change(r):
    """A support-API write that the bot actually kept."""
    for request in r.get("requests") or []:
        if request.get("method") == "GET" or request.get("status", 200) >= 400:
            continue
        if str(request.get("path", "")).endswith("/comments"):
            continue
        body = request.get("body") or {}
        if body:
            return request
    return None


def first_sentence(text):
    """The first full sentence, or the first line when there is no period."""
    raw = str(text).strip()
    if not raw:
        return ""
    line = " ".join(raw.splitlines()[0].split())
    for i, ch in enumerate(line):
        if i < 12:
            continue
        if ch in "!?":
            return line[:i + 1]
        if ch == "." and (i + 1 == len(line) or line[i + 1].isspace()):
            return line[:i + 1]
    return line


def shown(value):
    if isinstance(value, str) and len(value) > 160:
        return first_sentence(value)
    return show(value)


def model_said(r):
    saved = saved_change(r)
    if saved:
        body = dict(saved.get("body") or {})
        text = ", ".join(f"{k}={shown(v)}" for k, v in body.items())
        return text or saved.get("path", "a change")
    name, args = last_tool_args(r)
    if not args:
        return ""
    changes = args.get("changes") if isinstance(args.get("changes"), dict) else dict(args)
    body = ", ".join(f"{k}={shown(v)}" for k, v in changes.items())
    return f"{name}: {body}" if body else name


def expected_snippet(case):
    parts = []
    for path, want in (case.get("expect") or {}).items():
        parts.append(f"{short_name(path)} {show(want)}")
    for path, values in (case.get("contains") or {}).items():
        parts.append(f"{short_name(path)} includes {show(values)}")
    for spec in case.get("required_calls") or []:
        if isinstance(spec, dict):
            body = spec.get("body") or {}
            extra = ", ".join(f"{k}={show(v)}" for k, v in body.items() if k != "ticket_id")
            parts.append(f"{spec.get('call', 'an action')}" + (f" ({extra})" if extra else ""))
    return "; ".join(parts)


SHORT_WHY = {
    "chose trap doc": "The current rule and a trap doc both reached the model, and the bot followed the trap.",
    "misapplied rule": "The rule reached the model, but the bot answered wrong.",
    "execution": "The model said the right thing, but the bot did not save it.",
    "code decided": "The bot's own code made this decision, not the model.",
    "no tools": "The builder did not give the model a tool, so the bot's code saved the answer text.",
    "not kept": "The builder never stored this rule in the bot.",
    "not retrieved": "The rule is stored in the bot, but it never reached the model.",
    "trap doc": "Only an outdated or wrong doc reached the model.",
    "retrieval": "The rule never reached the model.",
    "rule buried": "The rule was in the prompt, but the bot only followed it once it was stated plainly.",
    "crashed": "The bot crashed.",
    "our service": "The LLM provider did not respond.",
}


def as_sentence(text):
    text = text.strip()
    if not text:
        return text
    if text[-1] not in ".!?":
        text += "."
    return text[0].upper() + text[1:]


def why_bot(r):
    """One complete reason this ticket failed."""
    if saved_change(r) is None:
        reasons = tool_errors(r)
        if reasons:
            return SHORT_WHY.get(reasons[-1], as_sentence(reasons[-1]))
    ordered = [b for b in (r.get("blame") or []) if b.get("blame") != "no tools"] or list(r.get("blame") or [])
    for b in ordered:
        if b.get("blame") == "execution":
            continue
        return SHORT_WHY.get(b["blame"], as_sentence(diagnose.BLAME_TEXT.get(b["blame"], b["blame"])))
    return SHORT_WHY["execution"]


def case_explanation(case, r):
    """One complete sentence each: asked, model, bot, why."""
    asked = expected_snippet(case).replace(";", ",").replace(" includes ", " including ")
    said = model_said(r)
    did = what_happened(case, r)
    if did.lower().startswith("bot "):
        did = "The " + did[0].lower() + did[1:]
    lines = [
        f"- Asked: {as_sentence('The ticket should have ' + asked if asked else 'The ticket should stay unchanged')}",
        f"- Model: {as_sentence('The model asked for ' + said if said else 'The model did not ask for a change')}",
        f"- Bot: {as_sentence(did)}",
        f"- Why: {why_bot(r)}",
    ]
    return lines


def design_lines(claims):
    if not claims:
        return []
    if not claims.get("given"):
        return ["## Design", "", f"The builder did not leave a valid description: {claims.get('error', 'missing')}.", ""]
    bad = [c for c in claims.get("claims", []) if not c["ok"]]
    lines = ["## Design", ""]
    if not bad:
        lines.append(f"{claims['right']} of {claims['checked']} checked claims match the recording.")
    else:
        lines += [f"{claims['right']} of {claims['checked']} claims match. These do not:", "",
                  "| Claim | Builder said | We saw |", "| --- | --- | --- |"]
        for c in bad:
            lines.append(f"| {c['claim'].removeprefix('agent.').replace('_', ' ')} | {c['said']} | {c['saw']} |")
    lines += design_text(claims)
    return lines + [""]


INFO_TYPES = {1: "API only", 2: "customer's facts", 3: "API call from the customer's info",
              4: "question from what the API shows"}


def info_summary(results, cases):
    """Pass rate by where a ticket's answer comes from (case info_type), and twin pairs: two tickets with the same
    opening but different answers. A pair counts only when both halves pass, so a bot that guesses instead of
    asking gets nothing for the half its guess happens to fit."""
    by_id = {c["id"]: c for c in cases}
    got = {r["id"]: bool(r.get("passed")) for r in results}
    by_type = {}
    for rid, ok in got.items():
        t = (by_id.get(rid) or {}).get("info_type")
        if t:
            row = by_type.setdefault(str(t), {"passed": 0, "total": 0})
            row["passed"] += ok
            row["total"] += 1
    pairs = sorted({tuple(sorted((rid, by_id[rid]["twin"]))) for rid in got
                    if (by_id.get(rid) or {}).get("twin") in got})
    passed = [p for p in pairs if got[p[0]] and got[p[1]]]
    if not by_type and not pairs:
        return None
    return {"by_type": dict(sorted(by_type.items())),
            "pairs": len(pairs), "pairs_passed": len(passed),
            "pair_rate": _pass_rate(len(passed), len(pairs)) if pairs else None,
            "pairs_one_half": [list(p) for p in pairs if got[p[0]] != got[p[1]]]}


def info_lines(info):
    if not info:
        return []
    lines = ["## Where the answer comes from", "",
             "Each ticket's answer needs the customer's facts, the support API, or both (its info type). Twin tickets "
             "share an opening but not the answer; a pair passes only when both halves do.", ""]
    if info["by_type"]:
        lines += ["| Info type | Passed |", "| --- | --- |"]
        for t, row in info["by_type"].items():
            lines.append(f"| {t}. {INFO_TYPES.get(int(t), t)} | {row['passed']} / {row['total']} |")
        lines.append("")
    if info["pairs"]:
        lines.append(f"Twin pairs passed: {info['pairs_passed']} / {info['pairs']}"
                     + (f" · one half only: {', '.join(' / '.join(p) for p in info['pairs_one_half'])}"
                        if info["pairs_one_half"] else ""))
        lines.append("")
    return lines


def render_report(results, cases, card=None, bot_files=(), claims=None, subset=None, context=None,
                  coverage=None, realization=None, attribution=None, knowledge_condition=None, qk=None, docs=None,
                  info=None):
    by_id = {c["id"]: c for c in cases}
    lines = []
    if knowledge_condition:
        lines += [
            "## Organizational knowledge condition",
            "",
            f"Condition: `{knowledge_condition}`.",
            f"Qk (this pack): **{(qk if qk is not None else 0.0):.4f}**.",
            "",
            "Fixed instruction I and fixed ticket suite S. Only the docs pack R varies.",
            "After all five conditions finish, run "
            "`python3 scripts/knowledge_delta_report.py <job-dir>` for ΔQk = Qcomplete − Qk.",
            "",
        ]
    lines += design_lines(claims)
    lines += info_lines(info)
    lines += subset_lines(subset)
    lines += context_lines(context)
    if docs:
        import doc_recall
        lines += doc_recall.doc_lines(docs)
    lines += coverage_lines(coverage, realization)
    lines += attribution_lines(attribution)
    lines += group_lines(results)
    lines += ["## Tickets", "",
              "| Ticket | End | Order | Fault |",
              "| --- | --- | --- | --- |"]
    for r in results:
        case = by_id.get(r["id"], {})
        name = f"{r['id']}. {case.get('title') or r.get('title', '')}"
        cols = r.get("columns") or {}
        end = "fail (us)" if ours_only(r) else show_column(r["passed"])
        lines.append(
            f"| {name} | {end} | {show_column(cols.get('order'))} | {fault_names(r)} |"
        )
    failed = [r for r in results if not r["passed"]]
    if failed:
        lines += ["", "## What failed", ""]
        for r in failed:
            case = by_id.get(r["id"], {})
            lines += [f"### {r['id']}. {case.get('title') or r.get('title', '')}", "",
                      *case_explanation(case, r), ""]
    lines += ["The full recording of each ticket is in `traces/`. The bot's code is in `bot/`.", ""]
    return "\n".join(lines) + "\n"


def apply_fixture(seed, fixture):
    state = copy.deepcopy(seed)
    for file, records in fixture.get("data", {}).items():
        for record_id, fields in records.items():
            state[file].setdefault(record_id, {}).update(fields)
    return state


def pack_self_check(cases, seed):
    """packs/<pack>/unknown.json: a field left as it was passes, a guessed value fails (blamed on the agent), and a
    handoff is no longer forbidden. Returns problems."""
    problems = []
    for spec_file in sorted((Path(__file__).resolve().parent / "packs").glob("*/unknown.json")):
        cond = spec_file.parent.name
        graded = {c["id"]: c for c in pack_cases(list(cases.values()), cond)}
        for cid in load_json(spec_file).get("tickets", {}):
            c = graded.get(cid)
            if not c or not c.get("unknown_fields"):
                problems.append(f"{cond}: {cid} is not in cases.json or has no unknown fields")
                continue
            if "POST /handoffs" in c.get("forbidden_calls", []):
                problems.append(f"{cond}: {cid} still forbids a handoff")
            left = copy.deepcopy(seed)
            if any("do not say this" in f for f in evaluate(c, left, [], seed)):
                problems.append(f"{cond}: {cid} fails a field the agent left as it was")
            guessed = copy.deepcopy(seed)
            path = c["unknown_fields"][0]
            file, record, field = path.split(".", 2)
            guessed.setdefault(file, {}).setdefault(record, {})[field] = "guessed-value"
            if not any("do not say this" in f for f in evaluate(c, guessed, [], seed)):
                problems.append(f"{cond}: {cid} passes a guessed {field}")
            checks = diagnose.failed_checks(c, guessed, [], seed, lookup)
            if not any(k["kind"] == "guessed" for k in checks):
                problems.append(f"{cond}: {cid} has no 'guessed' check for blame")
        print(f"pack overrides {cond}: {len(load_json(spec_file).get('tickets', {}))} tickets checked")
    return problems


def cmd_check(args):
    customer.self_check()
    sys.path.insert(0, str(Path(__file__).resolve().parent / "llm_hook"))
    import prompt_cap
    prompt_cap.self_check()
    cases = {c["id"]: c for c in load_json(args.cases)}
    seed = load_state(Path(args.seed))
    problems = pack_self_check(cases, seed)
    app = Path(args.app) if args.app else None

    if args.rules:
        rules = {r["id"]: r for r in load_json(args.rules)}
        for case in cases.values():
            if not case.get("rules"):
                problems.append(f"{case['id']}: has no rules")
            brief = str(case.get("customer") or "").strip()
            if not brief:
                problems.append(f"{case['id']}: has no customer brief")
            elif customer.PRIORITY.search(brief):
                problems.append(f"{case['id']}: customer brief contains a priority code")
            for rule_id in case.get("rules", []):
                if rule_id not in rules:
                    problems.append(f"{case['id']}: unknown rule {rule_id}")
        for rule in rules.values():
            if not rule.get("sources"):
                problems.append(f"{rule['id']}: has no sources")
            if app:
                for doc in rule.get("sources", []) + rule.get("decoys", []):
                    if not (app / doc).exists():
                        problems.append(f"{rule['id']}: doc not found {doc}")
                docs = diagnose.Docs(app)
                for key, where in (("evidence", "sources"), ("trap_evidence", "decoys")):
                    texts = [docs.text(d) or "" for d in rule.get(where, [])]
                    for e in rule.get(key, []):
                        if not any(diagnose.normalize(e) in t for t in texts):
                            problems.append(f"{rule['id']}: {key} not found in its {where}: {e[:60]!r}")

    has_good = set()
    for path in sorted(Path(args.fixtures).glob("*.json")):
        for fixture in load_json(path):
            case = cases.get(fixture["case"])
            if case is None:
                problems.append(f"{path.name}: unknown case {fixture['case']}")
                continue
            all_requests = fixture.get("requests", [])
            this_requests, requests = grade_requests(case, all_requests, fixture.get("already", 0))
            failures = evaluate(case, apply_fixture(seed, fixture), requests, seed, fixture.get("model_calls"), model_requests=this_requests, all_requests=all_requests)
            got = "fail" if failures else "pass"
            ok = got == fixture["should"]
            if fixture["should"] == "pass" and ok:
                has_good.add(case["id"])
            print(f"{'ok ' if ok else 'BAD'} {fixture['case']:8} {fixture['name']:32} should={fixture['should']:4} got={got}")
            if not ok:
                problems.append(f"{fixture['case']} / {fixture['name']}: should {fixture['should']}, got {got} {failures}")

    for case_id in cases:
        if case_id not in has_good:
            problems.append(f"{case_id}: no passing 'good' fixture")

    if args.blame_fixtures:
        rules_list = load_json(args.rules)
        rules_by_id = {r["id"]: r for r in rules_list}
        print()
        for fixture in load_json(args.blame_fixtures):
            case = cases[fixture["case"]]
            state = apply_fixture(seed, fixture)
            this_requests, requests = grade_requests(case, fixture.get("requests", []), fixture.get("already", 0))
            calls = fixture.get("model_calls", [])
            checks = diagnose.failed_checks(case, state, requests, seed, lookup, calls, model_requests=this_requests, all_requests=fixture.get("requests", []))
            got = sorted({b["blame"] for b in diagnose.blame_case(
                case, checks, rules_by_id, calls, fixture.get("bot_problem", ""), fixture.get("stored"))})
            want = sorted(fixture["expect_blame"])
            ok = got == want
            print(f"{'ok ' if ok else 'BAD'} blame {fixture['case']:8} {fixture['name']:32} want={want} got={got}")
            if not ok:
                problems.append(f"blame {fixture['case']} / {fixture['name']}: want {want}, got {got}")

    print()
    if problems:
        print("PROBLEMS:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("all fixtures behave as expected")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run")
    run.add_argument("--cases", default="/tests/cases.json")
    run.add_argument("--seed", default="/tests/seed")
    run.add_argument("--data", default="/srv/data")
    run.add_argument("--logs", default="/logs/verifier")
    run.add_argument("--bot-timeout", type=int, default=240)
    run.add_argument("--rules", default="/tests/rules.json")
    run.add_argument("--app", default="/app")
    run.add_argument("--workers", type=int, default=WORKERS, help="tickets to run at once")
    run.add_argument("--bot", default=str(BOT))
    run.add_argument("--server", default=str(SERVER))

    one = sub.add_parser("run-one", help="run a single ticket or follow-up pair (sandbox worker)")
    one.add_argument("--cases", default="/tests/cases.json")
    one.add_argument("--seed", default="/tests/seed")
    one.add_argument("--data", default="/srv/data")
    one.add_argument("--logs", default="/logs/verifier")
    one.add_argument("--bot-timeout", type=int, default=240)
    one.add_argument("--rules", default="/tests/rules.json")
    one.add_argument("--app", default="/app")
    one.add_argument("--bot", default=str(BOT))
    one.add_argument("--server", default=str(SERVER))
    one.add_argument("--case-id", help="solo or reliability ticket id")
    one.add_argument("--pair-head", help="first ticket id of a follow-up pair")
    one.add_argument("--out", default="/tmp/ticket_result.json")

    check = sub.add_parser("check")
    check.add_argument("--cases", required=True)
    check.add_argument("--seed", required=True)
    check.add_argument("--fixtures", required=True)
    check.add_argument("--rules")
    check.add_argument("--app")
    check.add_argument("--blame-fixtures")

    args = parser.parse_args()
    {"run": cmd_run, "run-one": cmd_run_one, "check": cmd_check}[args.cmd](args)


if __name__ == "__main__":
    main()
