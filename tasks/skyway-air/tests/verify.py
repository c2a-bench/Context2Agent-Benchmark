"""Deterministic verifier for the Skyway Air support agent.

run     - Harbor mode: for each case, reset data, run the bot (traced), compare JSON state,
          check that every change was a value the model said, write the reward. Then diagnose,
          optionally replay failed tickets (REPLAY=0 turns it off), and build the observed architecture card.
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

FILES = ["customers", "bookings", "flights", "bag_reports", "tickets", "refunds", "credits", "reimbursements",
         "approvals", "changes", "handoffs"]
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
    "category": "Category",
    "labels": "Labels",
    "status": "Status",
    "booking_id": "Booking on the ticket",
}
# Money and booking records: <file>.<booking or ticket>.<field>
MONEY_FIELDS = {
    "refunds": "Refund {field}",
    "credits": "Travel credit ({field})",
    "reimbursements": "Reimbursement ({field})",
    "approvals": "Supervisor approval request {field}",
    "changes": "Flight change {field}",
}
FILE_NAMES = {"tickets": "Tickets", "customers": "Customers", "bookings": "Bookings", "flights": "Flights",
              "bag_reports": "Bag reports", "refunds": "Refunds (money back to the original payment)",
              "credits": "Travel credits (money given to customers)", "reimbursements": "Reimbursements (money paid back)",
              "approvals": "Supervisor approval requests", "changes": "Flight changes", "handoffs": "Handoff queue"}
CALL_NAMES = {"POST /refunds": "refunded the customer", "POST /credits": "gave travel credit (money)",
              "POST /reimbursements": "reimbursed the customer", "POST /approvals": "asked a supervisor to approve a payment",
              "POST /bookings/*/change": "changed the booking's flight", "POST /handoffs": "handed the ticket to a person"}
REQUIRED_NAMES = {
    "POST /handoffs": "hand the ticket to a person",
    "POST /tickets/*/comments": "comment on the open ticket",
    "POST /refunds": "refund the customer",
    "POST /credits": "give travel credit",
}
GROUP_NAMES = {
    "normal": "Normal tickets", "handoff": "Must go to a person", "bad-actor": "Tricky customers",
    "changed-rule": "Changed rules", "new-rule": "New rules", "unchanged": "Unchanged rules",
    "missing_info": "Missing information", "ambiguous": "Ambiguous requests",
    "conflict": "Conflicting conditions", "escalate": "Escalation / resistance",
    "linguistic": "Linguistic variants", "behavior": "Customer behaviour",
    "lookup": "Needs lookups (booking / flight)",
}


def field_label(path):
    file, record_id, field = path.split(".", 2)
    if file in MONEY_FIELDS:
        return f"{MONEY_FIELDS[file].format(field=field.replace('_', ' '))} on {record_id}"
    return f"{FIELD_NAMES.get(field, field)} on {record_id}"


def grade_requests(case, all_requests, already=0):
    """Follow-up B is graded on writes after it started. A kill-then-restart stays one ticket."""
    this = all_requests[already:]
    return this, this if case.get("after") else all_requests


def first_attempt_id(requests, call_pattern):
    """The confirmation_id from the first successful matching payment. That id lives only on the response."""
    for request in requests:
        if request.get("status", 200) >= 400:
            continue
        if not fnmatch.fnmatchcase(call_of(request), call_pattern):
            continue
        aid = (request.get("response") or {}).get(diagnose.CONFIRMATION)
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


def attempt_posted(requests, paths, attempt_id):
    """A comment posted in these requests, on one of the tickets in paths, quotes attempt_id."""
    tickets = {path.split(".")[1] for path in paths}
    return any(r.get("status", 200) < 400 and r.get("method") == "POST"
               and fnmatch.fnmatchcase(r.get("path", "").split("?")[0], "/tickets/*/comments")
               and r["path"].split("/")[2] in tickets and attempt_id in str((r.get("body") or {}).get("body") or "")
               for r in requests)


def evaluate(case, state, requests, seed, calls=None, model_requests=None, all_requests=None):
    """Return a list of plain-language failure strings; empty means the case passed.
    calls = the recorded model calls (kept for blame/report helpers; no longer gates pass/fail).
    model_requests = writes compared to this start's model; defaults to requests.
    all_requests = the whole sandbox log (A then B). Used to find the first payment's confirmation_id."""
    failures = []
    writes = requests if model_requests is None else model_requests
    for path, want in case.get("expect", {}).items():
        found, got = lookup(state, path)
        if not found or got is None:
            failures.append(f"{field_label(path)}: not set by the bot (correct: {want!r})")
        elif got != want:
            failures.append(f"{field_label(path)}: bot set {got!r}, correct is {want!r}")
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
    for file, where in diagnose.unexpected_writes(case, state, seed):
        failures.append(f"{FILE_NAMES.get(file, file)}: the bot also changed {where}, which this ticket does not call for")
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
                f"Confirmation number: the bot never completed {spec['call']}, so there is no id to quote"
            )
        elif not (attempt_posted(requests, spec.get("in") or [], aid) if case.get("after")
                  else attempt_quoted(state, spec.get("in") or [], aid)):
            # A follow-up must give the id itself: a quote already on the first ticket does not answer it.
            failures.append(
                f"Confirmation number: a comment must quote {aid} from {spec['call']}"
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
        # One behaviour per ticket (scripts/assign_behaviors.py).
        return {"behavior": case["behavior"]} if case.get("behavior") else {}
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


def run_sandboxed(case, base, name, extra_text=None):
    """One ticket: own folder, own server. Ends when run_case returns."""
    rel = case.get("reliability") or {}
    start_world_clock()  # this ticket's clock (a kill_after restart and run_case below keep it)
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
                box, rel["kill_after"], None if extra_text else case.get("prompt_cap_tokens"),
                replay_hint(extra_text, case.get("facts") if case.get("facts_given") else ()),
            )
        return run_case(case, ctx, name, extra_text)
    finally:
        restore_stored(hidden)
        stop_server(server)


def run_pool(jobs, base, workers, prefix=""):
    """Start the next ticket as soon as a slot is free. jobs is (case, name, extra_text)."""
    if not jobs:
        return {}
    out = {}
    use_daytona = _ticket_backend() in ("daytona", "modal")  # one cloud sandbox per ticket
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {
            pool.submit(_run_solo_job, case, base, name, extra, use_daytona): name
            for case, name, extra in jobs
        }
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                r = fut.result()
            except Exception as exc:
                case = next(c for c, n, _ in jobs if n == name)
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


def _run_solo_job(case, base, name, extra_text, use_daytona):
    if use_daytona:
        import sandbox as ticket_sandbox
        return ticket_sandbox.run_solo(case, base, name, extra_text)
    return run_sandboxed(case, base, name, extra_text)


def _run_pair_job(first, second, base, extra=None, extra_first=None, prefix="", tag=""):
    if _ticket_backend() in ("daytona", "modal"):
        import sandbox as ticket_sandbox
        try:
            got = ticket_sandbox.run_pair(first, second, base, extra, extra_first)
        except Exception as exc:
            got = {
                first["id"]: crashed_result(first, exc),
                second["id"]: crashed_result(second, exc),
            }
        for r in got.values():
            print_ticket(r, prefix)
        return got
    return run_chain(first, second, base, extra=extra, extra_first=extra_first, prefix=prefix, tag=tag)


def run_pairs(heads, follow, base, workers, prefix=""):
    """Run follow-up pairs. Daytona: parallel sandboxes. Local: sequential on shared bot."""
    if not heads:
        return {}
    if _ticket_backend() not in ("daytona", "modal"):
        ensure_bot_writable(BOT.parent)
        got = {}
        for head in heads:
            got.update(run_chain(head, follow[head["id"]], base, prefix=prefix))
        return got
    out = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {
            pool.submit(_run_pair_job, head, follow[head["id"]], base, None, None, prefix): head["id"]
            for head in heads
        }
        for fut in as_completed(futures):
            out.update(fut.result())
    return out


def run_chain(first, second, base, extra=None, extra_first=None, prefix="", tag=""):
    """Ticket 1 then ticket 2, same folder and API. Does not wipe ticket 1.
    tag (e.g. "-replay") names a replay's traces and folder, so they do not overwrite the live run's.

    If the head has reliability.kill_after / fail_writes / hide_stored, apply the
    same prologue as run_sandboxed so confirmation-number pairs still share one desk.
    """
    rel = first.get("reliability") or {}
    start_world_clock()  # one clock for the pair: ticket 2 is handled after ticket 1, not back at the same moment
    name = f"{first['id']}__{second['id']}{tag}"
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
            trace_path = new_trace(ctx["trace_dir"], f"{first['id']}{tag}-first")
            run_bot_watch(
                ticket, ctx["api_url"], ctx["timeout"], ctx["hook_dir"], trace_path,
                box, rel["kill_after"], None if extra_first else first.get("prompt_cap_tokens"),
                replay_hint(extra_first, first.get("facts") if first.get("facts_given") else ()),
            )
        r1 = run_case(first, ctx, f"{first['id']}{tag}", extra_first)
        print_ticket(r1, prefix)
        r2 = run_case(second, ctx, f"{second['id']}{tag}", extra)
        print_ticket(r2, prefix)
        return {first["id"]: r1, second["id"]: r2}
    finally:
        restore_stored(hidden)
        stop_server(server)


def plain_case(case):
    """The ticket with the customer's information given: no behaviour, no goal change, and every fact in the bot's
    system prompt (replay_hint) while the customer still answers when asked."""
    out = {k: v for k, v in case.items() if k not in ("first_goal", "goal_terms")}
    out["behavior"] = "baseline"
    out["facts_given"] = True
    return out


def plain_replay(results, by_id, follow, base, workers, backend):
    """Behaviour replay (customer information given): a failed ticket that the full replay fixed runs again with
    the customer's information given (plain_case) and no rule. Passing means the rule was not needed; failing means
    it was."""
    jobs, meta, pairs = [], {}, []
    for r in results:
        case = by_id[r["id"]]
        if not replay_worthy(r) or not after_full(r) or isinstance(r.get("plain_replay"), dict):
            continue
        plain = plain_case(case)
        if case.get("after"):
            pairs.append((by_id[case["after"]], plain, r))
        elif case["id"] in follow:
            pairs.append((plain, follow[case["id"]], r))
        else:
            jobs.append((plain, f"{r['id']}-plain", None))
            meta[f"{r['id']}-plain"] = r
    done = [(meta[name], rr) for name, rr in run_pool(jobs, base, workers, prefix="PLAIN ").items()]
    if backend in ("daytona", "modal") and pairs:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futs = [(pool.submit(_run_pair_job, first, second, base, None, None, "PLAIN ", "-plain"), r)
                    for first, second, r in pairs]
            done += [(r, fut.result()[r["id"]]) for fut, r in futs]
    else:
        done += [(r, run_chain(first, second, base, prefix="PLAIN ", tag="-plain")[r["id"]]) for first, second, r in pairs]
    for r, rr in done:
        lost = replay_lost(rr)
        if lost:
            r["plain_replay_lost"] = lost
            r["plain_replay_lost_cost"] = {"usage": rr.get("usage"), "sandbox": rr.get("sandbox")}  # billed all the same
            continue
        r["plain_replay"] = {"passed": rr["passed"], "failures": rr["failures"], "bot_problem": rr["bot_problem"],
                         "usage": rr.get("usage"), "sandbox": rr.get("sandbox")}


def full_replay(results, by_id, follow, base, workers, backend, notes):
    """Full replay (rule and customer information given), first: the rule note with the customer's information given
    (plain_case), for every failed ticket. Failing means the bot cannot do it even with both given (execution), or
    the ticket itself is wrong; then the rule and behaviour replays are not run and are marked
    skipped, not failed. Passing means something was missing; the rule and behaviour replays then say which."""
    jobs, meta, pairs = [], {}, []
    for r in results:
        if not replay_worthy(r) or r["id"] not in notes:
            continue
        case = by_id[r["id"]]
        note, full = notes[r["id"]][1], plain_case(case)
        # In a follow-up pair only the replayed ticket changes (customer information given, rule note); the other ticket runs as it
        # did live, as in the rule and behaviour replays, so the verdict is about this ticket alone.
        if case.get("after"):
            pairs.append((by_id[case["after"]], full, r, note, None))
        elif case["id"] in follow:
            pairs.append((full, follow[case["id"]], r, None, note))
        else:
            jobs.append((full, f"{r['id']}-full", note))
            meta[f"{r['id']}-full"] = r
    done = [(meta[name], rr) for name, rr in run_pool(jobs, base, workers, prefix="FULL ").items()]
    if backend in ("daytona", "modal") and pairs:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futs = [(pool.submit(_run_pair_job, first, second, base, extra, extra_first, "FULL ", "-full"), r)
                    for first, second, r, extra, extra_first in pairs]
            done += [(r, fut.result()[r["id"]]) for fut, r in futs]
    else:
        done += [(r, run_chain(first, second, base, extra=extra, extra_first=extra_first, prefix="FULL ",
                               tag="-full")[r["id"]]) for first, second, r, extra, extra_first in pairs]
    for r, rr in done:
        lost = replay_lost(rr)
        if lost:
            r["full_replay_lost"] = lost
            r["full_replay_lost_cost"] = {"usage": rr.get("usage"), "sandbox": rr.get("sandbox")}  # billed all the same
            continue
        r["full_replay"] = {"passed": rr["passed"], "failures": rr["failures"], "bot_problem": rr["bot_problem"],
                         "usage": rr.get("usage"), "sandbox": rr.get("sandbox")}
        if not rr["passed"]:
            r["replays_skipped"] = "the full replay failed"


def after_full(r):
    """The rule and behaviour replays run only once the full replay passed (or was lost to us, then as before)."""
    full = r.get("full_replay")
    return (isinstance(full, dict) and full["passed"]) or bool(r.get("full_replay_lost"))


REPLAY_VERDICTS = {
    "prompt cap": "prompt cap: fixed once a replay ran without the ticket's token cap",
    "knowledge": "missing knowledge: fixed by the rule only, which had not reached the model",
    "application": "knowledge not applied: the rule had reached the model; fixed only when told it again",
    "customer": "customer behaviour: fixed by the customer's information only",
    "either": "either was enough: fixed by the rule, and by the customer's information",
    "both": "needed both: fixed only with the rule and the customer's information",
    "execution": "execution or ticket: fails even with the rule and the customer's information",
}


def replay_verdict(r, case):
    """Which given information fixes a failed ticket: the rule (r), the customer's information (c), or both."""
    if r.get("passed") or not replay_worthy(r):
        return None
    full = r.get("full_replay") if isinstance(r.get("full_replay"), dict) else None
    if full and not full["passed"]:
        return "execution"
    rule = r.get("replay") if isinstance(r.get("replay"), dict) else None
    if not rule or not isinstance(r.get("plain_replay"), dict):
        return None
    plain_passed = bool(r["plain_replay"]["passed"])
    if r.get("prompt_cap_tokens") and "context overflow" in {b.get("blame") for b in r.get("blame") or []}:
        # Replays run without the cap, so a pass says the cap was the problem, not the rule or the customer.
        if rule["passed"] or plain_passed or (r.get("full_replay") or {}).get("passed"):
            return "prompt cap"
    if rule["passed"]:
        if plain_passed:
            return "either"
        return "knowledge" if diagnose.replay_class(r)[1] == "lacked the rule" else "application"
    if plain_passed:
        return "customer"
    return "both" if full else None


def verdict_summary(results, by_id):
    counts = {}
    for r in results:
        v = replay_verdict(r, by_id.get(r["id"], {}))
        r["replay_verdict"] = v
        if v:
            counts[v] = counts.get(v, 0) + 1
    return counts


def verdict_lines(counts):
    if not counts:
        return []
    lines = ["## Why failed tickets failed (replays)", "",
             "Each failed ticket is replayed first with both the rule and the customer's information given (as "
             "guidance in the bot's system prompt, not as customer text). If that fails, the bot cannot do it. If it passes, the ticket is replayed "
             "with the rule only and with the customer's information only; which one fixes it says what was "
             "missing.", "",
             "| Verdict | Tickets |", "| --- | --- |"]
    for k, label in REPLAY_VERDICTS.items():
        if counts.get(k):
            lines.append(f"| {label} | {counts[k]} |")
    return lines + [""]


def replay_worthy(r):
    """A failed ticket a replay can tell us something about. Not ours, and the bot really ran: a crash or a
    failed model call tests no rule. A crash only because the prompt went over the ticket's cap still is
    worth it: the replay is uncapped, so it shows whether the bot knew the rule."""
    if r["passed"] or ours_only(r):
        return False
    labels = {b["blame"] for b in r["blame"]}
    if "model call failed" in labels:
        return False
    return not r["bot_problem"] or labels == {"context overflow"}


def replay_lost(rr):
    """Why a replay tells us nothing about the bot (customer model failed, provider down, our time limit), or ""."""
    if not ours_only(rr):
        return ""
    return rr.get("customer_fault") or "; ".join(b.get("detail") or b["blame"] for b in rr.get("blame") or []) or "ours"


def record_replay(r, rule_ids, note, rr):
    """Keep the rule replay on the ticket. A replay lost to us is not counted (the ticket stays not replayed)."""
    lost = replay_lost(rr)
    if lost:
        r["replay_lost"] = lost
        r["replay_lost_cost"] = {"usage": rr.get("usage"), "sandbox": rr.get("sandbox")}  # billed all the same
        return
    diagnose.apply_replay(r["blame"], rr["passed"])
    r["replay"] = {"rules": rule_ids, "note": note, "passed": rr["passed"], "usage": rr.get("usage"), "sandbox": rr.get("sandbox"),
                   "failures": rr["failures"], "bot_problem": rr["bot_problem"]}


REPLAY_KEYS = ("full_replay", "replay", "plain_replay")


def cost_summary(results):
    """What grading this stage cost: model tokens and dollars for the bot and the customer model, on the tickets and on
    their replays, plus the Daytona sandboxes' life and cost. None for results graded before usage was recorded."""
    rs = [r for r in results if isinstance(r, dict)]
    if not any(r.get("usage") for r in rs):
        return None
    use = lambda r, who: (r.get("usage") or {}).get(who)
    # Replays lost to us were billed too, so their cost counts.
    replays = [r[k] for r in rs for k in REPLAY_KEYS + tuple(f"{x}_lost_cost" for x in REPLAY_KEYS) if isinstance(r.get(k), dict)]
    # A sandbox shared by a pair is split over its two results; a replay keeps only its own result, so it counts the
    # whole sandbox.
    boxes = [r.get("sandbox") for r in rs if r.get("sandbox")]
    replay_boxes = [x["sandbox"] for x in replays if x.get("sandbox")]
    box_seconds = sum(b["seconds"] for b in boxes) + sum(b.get("whole_seconds", b["seconds"]) for b in replay_boxes)
    box_usd = sum(b["usd"] for b in boxes) + sum(b.get("whole_usd", b["usd"]) for b in replay_boxes)
    out = {
        "bot": observe_usage.add(*[use(r, "bot") for r in rs]),
        "customer": observe_usage.add(*[use(r, "customer") for r in rs]),
        "replay_bot": observe_usage.add(*[use(x, "bot") for x in replays]),
        "replay_customer": observe_usage.add(*[use(x, "customer") for x in replays]),
        "sandbox": {"runs": len(boxes) + len(replay_boxes), "seconds": round(box_seconds, 1), "usd": round(box_usd, 6)},
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


def replay_hint(rule=None, facts=()):
    """What a replay gives the bot, as guidance from the support team in its system prompt (added to every model
    call by the trace hook), never as customer text: bots rightly distrust instructions in customer text, where
    injection tickets hide them. The bot must still confirm the details with the customer before it acts."""
    parts = [p for p in (
        (rule or "").strip(),
        ("What the customer has told us about this ticket:\n" + "\n".join(f"- {f}" for f in facts)) if facts else "",
    ) if p]
    if not parts:
        return None
    return ("Guidance from the support team for this ticket (not from the customer).\n\n" + "\n\n".join(parts)
            + "\n\nStill confirm the details this ticket needs with the customer before you act, and act only on "
              "what the customer confirms.")


# The world's clock: the stage's "now" (task.toml WORLD_NOW, e.g. 2026-12-02T10:00:00Z, when its tickets were
# created). Each ticket (a follow-up pair: once for both) starts the bot's clock there; it runs on from it.
_clock = threading.local()


def start_world_clock():
    """Set the bot's clock offset for the ticket that starts now: WORLD_NOW minus the real time. None without WORLD_NOW."""
    raw = (os.environ.get("WORLD_NOW") or "").strip()
    _clock.offset = None
    if raw:
        import datetime as _dt
        world = _dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        _clock.offset = round(world.timestamp() - time.time())  # whole seconds: the shell's date adds it exactly
    return _clock.offset


def bot_env(api_url, hook_dir, trace, prompt_cap=None, hint=None):
    offset = getattr(_clock, "offset", None)
    if offset is None and os.environ.get("WORLD_NOW"):
        offset = start_world_clock()
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
    if hint:
        env["BOT_SYSTEM_HINT"] = hint  # the trace hook appends it to the bot's own system message on every model call
    if offset is not None:
        env["BOT_CLOCK_OFFSET"] = str(offset)  # the hook shifts the bot's clocks; bin/date does the shell's
        shim = Path(hook_dir) / "bin"
        if (shim / "date").exists():
            os.chmod(shim / "date", 0o755)  # an upload to a sandbox may drop the mode
            env["PATH"] = f"{shim}:{env['PATH']}"
    for key in PROVIDER_KEYS:
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def run_bot(ticket, api_url, timeout, hook_dir, trace, prompt_cap=None, hint=None):
    """Run the bot once. Returns (contract failures, stderr tail, parsed last output line or None)."""
    env = bot_env(api_url, hook_dir, trace, prompt_cap, hint)
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


def run_bot_watch(ticket, api_url, timeout, hook_dir, trace, data_dir, kill_after, prompt_cap=None, hint=None):
    """Start the bot. If a matching write lands, kill it. Returns (failures, stderr, killed)."""
    env = bot_env(api_url, hook_dir, trace, prompt_cap, hint)
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


def column_results(case, passed, requests, bot_problem="", extra_text=None):
    """End is the last ticket. Order is the only extra check; it does not change the score."""
    columns = {"end": bool(passed), "order": None}
    if extra_text or bot_problem:
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


def run_case(case, ctx, name, extra_text=None):
    """The customer speaks first. After each bot exit the customer may reply again.

    On a replay, extra_text is the company rule. The conversation runs as on a live ticket, with the
    customer model; the rule (and on a "customer information given" replay, the customer's facts) reaches the bot as
    guidance in its system prompt on every start (replay_hint). The customer never sees it.
    """
    rules_by_id = ctx["rules_by_id"]
    if not ctx.get("keep_state"):
        start_world_clock()  # a new ticket; the second ticket of a follow-up pair keeps the pair's clock
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
    policy = (extra_text or "").strip() or None
    hint = replay_hint(policy, facts if case.get("facts_given") else ())
    # Replay is uncapped. Live tickets use the case cap, if any.
    prompt_cap = None if policy else case.get("prompt_cap_tokens")
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
    if brief and case.get("facts_given"):
        # Replay with the customer's information given (plain_case): the facts reach the bot in its system prompt
        # (hint); the customer opens with the opening as written and still answers when asked.
        opener = ticket["message"] if case.get("verbatim_opening") else brief
        turns.append({"reply": opener})
        ticket["message"] = opener
        history.append(("Customer", opener))
    elif brief and case.get("verbatim_opening"):
        # The ticket text is the test (e.g. an injection): send it exactly as written.
        opener = ticket["message"]
        turns.append({"reply": opener})
        history.append(("Customer", opener))
    elif brief and case.get("twin"):
        # Twins share an opening but not the answer. Their first message is that opening word for word (or the
        # shared first request of a goal change), so it never tells them apart: only asking does. The behaviour
        # shapes every later reply.
        opener = case.get("first_goal") if behavior == "goal_change" and case.get("first_goal") else brief
        # A behaviour that shapes the first message starts with the next one instead.
        behavior = customer.AFTER_OPENING.get(behavior or "", behavior)
        turns.append({"reply": opener})
        ticket["message"] = opener
        history.append(("Customer", opener))
    elif brief:
        first = ("Send your first message to support, the way 'How you write and behave' says."
                 if customer.BEHAVIOR_RULES.get(behavior or "") else
                 "Send your first message to support. Use only the opening.")
        spoken = customer.ask(brief, first, facts=facts, behavior=behavior, first_goal=case.get("first_goal"))
        customer_usage.append(spoken.get("usage"))
        if spoken.get("fault"):
            customer_fault = spoken["fault"]
        else:
            opener = spoken["reply"]
            turns.append({"reply": opener})
            ticket["message"] = opener
            history.append(("Customer", opener))
    ended_by = "error"
    while not customer_fault:
        remaining = int(budget - used)
        if remaining < 1:
            failures, stderr = [timeout_message(budget, used, starts)], ""
            break
        started = time.monotonic()
        run_start = time.time()
        starts += 1
        failures, stderr, out = run_bot(
            ticket, ctx["api_url"], remaining, ctx["hook_dir"], trace_path, prompt_cap, hint,
        )
        last = time.monotonic() - started
        bot_runs.append({"start": round(run_start, 3), "end": round(time.time(), 3), "seconds": round(last, 2)})
        used += last
        if failures and failures[0].startswith(TIMED_OUT):
            failures = [timeout_message(budget, used, starts, last)]
        if failures or not brief:
            ended_by = "error" if failures else "single message"  # no customer on this ticket: one bot run
            break
        said = bot_reply(out)
        # A goal-change ticket opens with another request; the real one comes in the customer's 2nd or 3rd message.
        # Until the customer has switched, neither side can end it: the bot would be graded on a request it never got.
        may_end = behavior != "goal_change" or any(t.get("switched") for t in turns)
        if (out or {}).get("end") is True and may_end:  # the bot ended the conversation: the customer is not asked again
            if said:
                turns.append({"support": [said]})
            ended_by = "agent"
            break
        if len(turns) >= customer.MAX_REPLIES or budget - used < 1:
            if said:
                turns.append({"support": [said]})
            ended_by = "limit"
            break
        did = f"Support said: {said}" if said else "Support did not reply."
        thread = "\n\n".join([*(f"{who}: {text}" for who, text in history), did, "Reply to support."])
        if said:
            history.append(("Support", said))
        spoken = customer.ask(brief, thread, facts=facts, behavior=behavior, first_goal=case.get("first_goal"))
        customer_usage.append(spoken.get("usage"))
        if spoken.get("fault"):
            customer_fault = spoken["fault"]
            break
        reply = spoken["reply"]
        history.append(("Customer", reply))
        turns.append({"support": [said] if said else [], "reply": reply, "corrected": bool(spoken.get("corrected")),
                      "switched": bool(spoken.get("switched")), "done": bool(spoken.get("done"))})
        ticket["message"] = "\n\n".join(f"{who}: {text}" for who, text in history)
        if spoken.get("done") and (behavior != "goal_change" or any(t.get("switched") for t in turns)):
            # the customer closed the conversation: the bot is not started again
            ended_by = "customer"
            break
    if behavior == "goal_change" and not customer_fault:
        said = [t for t in turns if t.get("reply")]
        terms = [str(x).lower() for x in case.get("goal_terms") or []]
        names_b = lambda text: any(x in text.lower() for x in terms)
        # The customer must open with the other request and move to the real one by its 2nd or 3rd message
        # (it flags the switch; the real request's words also count, for a switch it forgot to flag). If not,
        # the bot never got the goal change it is graded on, which is ours, not the bot's.
        if said and names_b(said[0]["reply"]) and not said[0].get("switched"):
            customer_fault = "The customer opened with the real request, so there was no goal change."
        elif len(said) >= 2 and not any(t.get("switched") or names_b(t["reply"]) for t in said[1:3]):
            customer_fault = "The customer did not switch to the real request by its third message."
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
    # What the bot told the customer (deterministic NL assertions); skipped when the bot never finished.
    said_checks = [] if bot_problem else diagnose.nl_checks(case, turns, requests, starting, bool(failures))
    # They never fail the ticket: pass/fail is the end state. They are scored apart (strict and communication).
    checks = diagnose.failed_checks(case, state, requests, starting, lookup, calls, model_requests=this_requests, all_requests=all_requests) if failures and not bot_problem else []
    blame = diagnose.blame_case(case, checks, rules_by_id, calls, bot_problem, ctx.get("stored"), stderr) if failures else []
    if blame and not calls and not bot_problem and this_requests and not any(e.get("kind") == "start" for e in trace):
        # The bot exited cleanly and used the API, but our watcher never loaded, so nothing it asked the
        # model was recorded: ours. A bot that failed to start keeps its own blame.
        blame = [diagnose.blame_record("trace", case.get("rules", []), "trace lost",
                                       "no model call was recorded because the LLM watcher did not load")]
    if customer_fault:
        # The conversation could not run as written: the ticket is ours, not the bot's.
        blame = [diagnose.blame_record("customer", [], "customer fault", customer_fault)]
    passed = not failures
    columns = column_results(case, passed, requests, bot_problem, extra_text)
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
        # Why the conversation stopped: customer (said it was done), agent (its output said end), limit (the
        # customer's message limit or the time budget), single message (no customer), or error (bot failure,
        # timeout, customer model fault).
        "ended_by": ended_by,
        "nl_checks": said_checks,
        "passed_strict": passed and not any(c["severity"] == "strict" for c in said_checks),
        # The customer flags only corrections of what support said, not its own earlier mistakes.
        "customer_corrections": sum(1 for t in turns if t.get("corrected")),
        "conversation": ticket.get("message") or "",
        "customer_fault": customer_fault,
        "prompt_cap_tokens": prompt_cap,
    }


def prepare_run(args):
    """What `run` and `replay` share: the bot, the data dirs, the LLM trace hook and the ticket runner's base."""
    global BOT, SERVER
    BOT, SERVER = Path(args.bot), Path(args.server)
    cases = load_json(args.cases)
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
    base = {
        "work_root": work_root, "seed_dir": seed_dir, "seed": load_state(seed_dir),
        "trace_dir": trace_dir, "hook_dir": hook_dir, "timeout": args.bot_timeout,
        "app": args.app,
        "rules_by_id": {r["id"]: r for r in rules},
        "stored": diagnose.stored_corpus(BOT.parent),
        "bot_path": BOT,
        "server_path": SERVER,
    }
    return cases, rules, logs, bot_files, self_report, baseline, trace_dir, base


def cmd_run(args):
    cases, rules, logs, bot_files, self_report, baseline, trace_dir, base = prepare_run(args)
    workers = getattr(args, "workers", WORKERS)
    solo, heads, follow, special = split_cases(cases)
    backend = _ticket_backend()
    print(f"Running {len(cases)} tickets via {backend}, {workers} at a time"
          + (f", {len(heads)} follow-up pair(s)" if heads else "")
          + (f", {len(special)} reliability ticket(s)" if special else "")
          + ".")
    # Daytona: solos + reliability tickets each get their own sandbox, so fan out together.
    # Local: reliability tickets stay sequential after solos (they mutate the shared bot tree).
    first_wave = solo + (special if backend in ("daytona", "modal") else [])
    got = run_pool([(case, case["id"], None) for case in first_wave], base, workers)
    got.update(run_pairs(heads, follow, base, workers))
    if backend not in ("daytona", "modal"):
        for case in special:
            try:
                r = run_sandboxed(case, base, case["id"])
            except Exception as exc:
                r = crashed_result(case, exc)
            got[case["id"]] = r
            print_ticket(r)
    results = [got[case["id"]] for case in cases]
    if args.no_replay:
        print("Replay skipped.")
    if not args.no_replay:
        run_replays(results, cases, follow, base, workers, backend)

    finish(results, cases, rules, BOT.parent, logs, baseline, self_report, bot_files, trace_dir)


# Everything a replay writes on a result, cleared before the replays run again.
REPLAY_FIELDS = REPLAY_KEYS + ("full_replay_lost", "replay_lost", "plain_replay_lost", "full_replay_lost_cost",
                               "replay_lost_cost", "plain_replay_lost_cost", "replays_skipped", "replay_verdict")
# Blame the grader sets after the checks (a watcher gap, the customer model): kept, not recomputed.
KEPT_BLAME = ("trace lost", "customer fault")


def cmd_replay(args):
    """Replay a finished step's failed tickets again with this grader and the step's saved bot, keeping every live
    result: each failed ticket's replays are cleared, its blame is recomputed from the saved checks (a replay can
    relabel it), and the replays run as in `run`. Then the step's scores and report are rebuilt."""
    cases, rules, logs, bot_files, self_report, baseline, trace_dir, base = prepare_run(args)
    workers = getattr(args, "workers", WORKERS)
    results = load_json(args.results)
    by_id = {c["id"]: c for c in cases}
    stale = [r["id"] for r in results if r["id"] not in by_id]
    if stale:
        sys.exit(f"results have tickets these cases do not: {', '.join(stale[:5])}")
    for r in results:
        for k in REPLAY_FIELDS:
            r.pop(k, None)
        if r["passed"] or not r.get("checks") or any(b.get("blame") in KEPT_BLAME for b in r.get("blame") or []):
            continue
        r["blame"] = diagnose.blame_case(by_id[r["id"]], r["checks"], base["rules_by_id"], r.get("model_calls") or [],
                                         r.get("bot_problem") or "", base["stored"], r.get("bot_stderr_tail") or "")
    _, _, follow, _ = split_cases(cases)
    backend = _ticket_backend()
    print(f"Replaying {sum(replay_worthy(r) for r in results)} failed tickets via {backend}, {workers} at a time.")
    run_replays(results, cases, follow, base, workers, backend)
    finish(results, cases, rules, BOT.parent, logs, baseline, self_report, bot_files, trace_dir)


def run_replays(results, cases, follow, base, workers, backend):
    """The replays of the failed tickets: the full replay (rule and customer facts given) first;
    the rule and behaviour replays only where it passed. Updates the results in place."""
    # A replay is a new conversation from the ticket's own story, with the customer model.
    by_id = {c["id"]: c for c in cases}
    follow = {after: by_id[case["id"]] for after, case in follow.items()}
    notes = {r["id"]: diagnose.replay_note(by_id[r["id"]], r["checks"], base["rules_by_id"])
             for r in results if replay_worthy(r)}
    # Full replay first (rule and customer given); the rule and behaviour replays only where it passed.
    full_replay(results, by_id, follow, base, workers, backend, notes)
    replay_jobs = []
    replay_meta = {}
    replay_pairs = []
    for r in results:
        if not replay_worthy(r) or not after_full(r) or isinstance(r.get("replay"), dict):
            continue
        rule_ids, note = notes[r["id"]]
        case = by_id[r["id"]]
        if case.get("after"):
            replay_pairs.append((by_id[case["after"]], case, note, r, rule_ids))
        elif case["id"] in follow:
            replay_pairs.append((case, follow[case["id"]], note, r, rule_ids))
        else:
            replay_jobs.append((case, f"{r['id']}-replay", note))
            replay_meta[f"{r['id']}-replay"] = (r, rule_ids, note)
    replayed = run_pool(replay_jobs, base, workers, prefix="REPLAY ")
    if backend in ("daytona", "modal") and replay_pairs:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futs = []
            for first, second, note, r, rule_ids in replay_pairs:
                extra = note if r["id"] == second["id"] else None
                extra_first = note if r["id"] == first["id"] else None
                futs.append((pool.submit(
                    _run_pair_job, first, second, base, extra, extra_first, "REPLAY ", "-replay"
                ), r, rule_ids, note))
            for fut, r, rule_ids, note in futs:
                pair = fut.result()
                rr = pair[r["id"]]
                record_replay(r, rule_ids, note, rr)
    else:
        for first, second, note, r, rule_ids in replay_pairs:
            pair = run_chain(
                first, second, base,
                extra=note if r["id"] == second["id"] else None,
                extra_first=note if r["id"] == first["id"] else None,
                prefix="REPLAY ", tag="-replay",
            )
            rr = pair[r["id"]]
            record_replay(r, rule_ids, note, rr)
    for name, (r, rule_ids, note) in replay_meta.items():
        rr = replayed[name]
        record_replay(r, rule_ids, note, rr)
    plain_replay(results, by_id, follow, base, workers, backend)


def finish(results, cases, rules, bot_dir, logs, baseline, self_report, bot_files, trace_dir=None):
    """Score a stage from its ticket results and write results.json, architecture.json, scores.json,
    reward.txt and report.md."""
    card = diagnose.architecture_card(results, baseline, str(bot_dir))
    # skyway-air: the architecture the run was told to build (scripts/run_arch.sh), checked against what was found.
    check = diagnose.architecture_check(os.environ.get("ARCHITECTURE"), card["knowledge_access"])
    if check:
        card["architecture_check"] = check
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
    taxonomy = scores["failure_taxonomy"] = diagnose.failure_taxonomy(counted)
    correction = scores["agent_correction"] = agent_correction_summary(counted)
    nl = scores["nl"] = nl_summary(counted)
    info = info_summary(counted, cases)
    if info:
        scores["info"] = info
    if cost:
        scores["cost"] = cost
    verdicts = verdict_summary(counted, {c["id"]: c for c in cases})
    if verdicts:
        scores["replay_verdicts"] = verdicts
    if docs:
        scores["docs"] = {k: v for k, v in docs.items()}
    (logs / "results.json").write_text(json.dumps(results, indent=2))
    (logs / "architecture.json").write_text(json.dumps({"observed": card, "self_report": claims, "subset": subset, "context": context}, indent=2))
    (logs / "scores.json").write_text(json.dumps(scores, indent=2))
    (logs / "reward.txt").write_text(f"{reward:.4f}\n")
    (logs / "report.md").write_text(render_report(results, cases, card, bot_files, claims, subset, context, coverage, realization,
                                                       attribution, taxonomy, correction, nl, docs=docs, info=info,
                                                       verdicts=verdicts))
    if docs and docs.get("tickets"):
        print(f"Docs reached: recall {docs['recall']}, precision {docs['precision']} over {docs['tickets']} tickets")
    print(f"\n{passed}/{len(counted)} cases passed, reward {reward:.4f}" + (f" ({ours} failed because of us)" if ours else ""))
    if coverage:
        if coverage.get("mode") == "per_ticket":
            print(f"Qcoverage {coverage['q_coverage']:.4f} across {coverage['n_behaviors']} behaviours")
        else:
            print(f"Qcoverage {coverage['q_coverage']:.4f} across {coverage['n_scenarios']} scenarios")
    if attribution:
        if attribution.get("mode") == "per_ticket":
            print(f"Failed tickets {attribution['failed']}: lacked the rule {attribution['lacked_rule']}, "
                  f"fixed when told {attribution['fixed_when_told']}, cannot apply {attribution['cannot_apply']}, "
                  f"execution {attribution['execution']}; "
                  f"passed with the customer's information given {attribution['plain_passed']}/{attribution['plain_replayed']}")
        else:
            print(f"Behaviour failures {attribution['behavior_failures']}, doc failures {attribution['doc_failures']}")
    if realization and realization.get("mean_q_realization") is not None:
        print(f"Mean Qrealization {realization['mean_q_realization']:.4f}")
    print(f"Strict score {nl['strict_score']:.4f} ({nl['strict_breaches']} reply breach(es)); "
          f"communication: {nl['tickets_clean']}/{nl['tickets']} tickets with no reply issue")
    if correction["tickets"]:
        print(f"Agent correction: {correction['tickets']} ticket(s) corrected, {correction['fixed']} still right")
    if taxonomy["records"]:
        print("Failed checks by party: " + ", ".join(f"{p} {n}" for p, n in taxonomy["by_party"].items()))
    if ka.get("replayed"):
        print(f"Qapplication {ka['Qapplication']:.4f} (replay {ka['replay_passed']}/{ka['replayed']})")
    print(f"Readable report: {logs / 'report.md'}")


def cmd_run_one(args):
    """Worker entrypoint: one ticket or one follow-up pair. Writes JSON results and exits."""
    global BOT, SERVER
    BOT, SERVER = Path(args.bot), Path(args.server)
    cases = load_json(args.cases)
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
        got = run_chain(head, follow[head["id"]], base, extra=args.extra, extra_first=args.extra_first)
    else:
        if not args.case_id or args.case_id not in by_id:
            raise SystemExit(f"unknown case id: {args.case_id}")
        case = by_id[args.case_id]
        ensure_bot_writable(BOT.parent)
        key = args.result_name or case["id"]
        try:
            r = run_sandboxed(case, base, case["id"], args.extra)
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
    "category": "category",
    "labels": "labels",
    "status": "status",
    "booking_id": "booking",
}
SHORT_CALLS = {"POST /refunds": "refund", "POST /credits": "give travel credit", "POST /reimbursements": "reimburse",
               "POST /approvals": "ask for approval", "POST /bookings/*/change": "change the flight",
               "POST /handoffs": "hand off to a person"}


def observe(case, state, requests, seed, model_calls=None, model_requests=None):
    """What the bot actually left behind, for every field the case checks, and changes the model never said."""
    writes = requests if model_requests is None else model_requests
    paths = list(case.get("expect", {})) + list(case.get("contains", {})) + list(case.get("not_contains", {}))
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
    return f"{file.rstrip('s')} {field.replace('_', ' ')}" if file in MONEY_FIELDS else SHORT_FIELDS.get(field, field)


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
    for file, where in diagnose.unexpected_writes(case, state, seed):
        lines += [f"- also changed {file} {where}", f"+ no change to {file} {where}"]
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


def replay_sentence(r):
    rp = r.get("replay")
    if not rp:
        return ""
    if rp["passed"]:
        return "When we put the rule on the ticket, the bot got it right."
    return "When we put the rule on the ticket, the bot still got it wrong."


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
# One behaviour subcategory per ticket (scripts/behavior/types.json); families are only for adding up.
BEHAVIOR_ORDER = ["baseline", "on_request", "incremental", "underspecified", "ambiguous", "self_correction", "urgency_mismatch", "pushback", "exception_request", "urgency_pressure", "person_request", "frustration", "goal_change", "disfluency"]
BEHAVIOR_NAMES = {
    "baseline": "Baseline",
    "on_request": "On request",
    "incremental": "Incremental",
    "underspecified": "Underspecified",
    "ambiguous": "Ambiguous",
    "self_correction": "Self-correction",
    "urgency_mismatch": "Urgency mismatch",
    "pushback": "Pushback",
    "exception_request": "Exception request",
    "urgency_pressure": "Urgency pressure",
    "person_request": "Person request",
    "frustration": "Frustration",
    "goal_change": "Goal change",
    "disfluency": "Disfluency",
}
BEHAVIOR_FAMILY = {
    "baseline": "Baseline",
    "on_request": "Information exchange",
    "incremental": "Information exchange",
    "underspecified": "Ambiguity",
    "ambiguous": "Ambiguity",
    "self_correction": "Correction",
    "urgency_mismatch": "Framing conflict",
    "pushback": "Resistance",
    "exception_request": "Resistance",
    "urgency_pressure": "Escalation",
    "person_request": "Escalation",
    "frustration": "Frustration",
    "goal_change": "Goal change",
    "disfluency": "Linguistic form",
}


def _behavior_key(b):
    return (BEHAVIOR_ORDER.index(b) if b in BEHAVIOR_ORDER else len(BEHAVIOR_ORDER), b)


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
        return behavior_profile(results)
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


def behavior_profile(results):
    """One behaviour per ticket: pass rate per behaviour over every ticket that has it.
    Qcoverage = mean of those rates (each behaviour weighs the same); normal is the baseline."""
    rows = {}
    for r in results:
        b = r.get("behavior")
        if not b or r.get("scenario"):
            continue
        row = rows.setdefault(b, {"passed": 0, "total": 0})
        row["total"] += 1
        row["passed"] += int(bool(r["passed"]))
    if not rows:
        return None
    by_category = {}
    for b in sorted(rows, key=_behavior_key):
        row = rows[b]
        by_category[b] = {"scenarios": row["total"], "passed": row["passed"], "total": row["total"],
                          "q": _pass_rate(row["passed"], row["total"])}
    by_family = {}
    for b, row in by_category.items():
        fam = by_family.setdefault(BEHAVIOR_FAMILY.get(b, b), {"passed": 0, "total": 0})
        fam["passed"] += row["passed"]
        fam["total"] += row["total"]
    for fam in by_family.values():
        fam["q"] = _pass_rate(fam["passed"], fam["total"])
    return {
        "mode": "per_ticket",
        "q_coverage": sum(r["q"] for r in by_category.values()) / len(by_category),
        "by_family": by_family,
        "weights": "uniform_behavior",
        "n_scenarios": 0,
        "n_behaviors": len(by_category),
        "by_category": by_category,
        "by_scenario": [],
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
        return behavior_failure_split(results)
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


def behavior_failure_split(results):
    """One behaviour per ticket: what each failed ticket says when replayed with the rule given.
    lacked_rule  passed once told, and the rule had not reached the model (knowledge);
    fixed_when_told / cannot_apply  the rule had reached the model, or the bot fails even when told:
                  the behaviour or applying the rule is the problem;
    execution  the full replay (rule and customer's information given) failed too, so the other replays were skipped;
    ours / bot_errors  lost to us, or a crash / no model call, so no rule was tested;
    plain_replayed / plain_passed  failed tickets run again with the customer's information given and no rule (after the full
                  replay), and how many then passed: the behaviour cost those tickets."""
    kinds = ("failed", "ours", "bot_errors", "lacked_rule", "fixed_when_told", "cannot_apply", "execution", "not_replayed",
             "plain_replayed", "plain_passed")
    by_behavior = {}
    for r in results:
        b = r.get("behavior")
        if not b or r.get("scenario"):
            continue
        row = by_behavior.setdefault(b, {"tickets": 0, **{k: 0 for k in kinds}})
        row["tickets"] += 1
        if r.get("passed"):
            continue
        row["failed"] += 1
        owner = run_owner(r)
        if owner == "us":
            row["ours"] += 1
        elif owner == "bot" and not isinstance(r.get("replay"), dict):
            # A crash over the prompt cap is replayed (uncapped), so it is classed by its replay below.
            row["bot_errors"] += 1
        elif isinstance(r.get("replay"), dict):
            _, reason = diagnose.replay_class(r)
            row[{"lacked the rule": "lacked_rule", "fixed when told": "fixed_when_told",
                 "cannot apply": "cannot_apply"}[reason]] += 1
        elif isinstance(r.get("full_replay"), dict) and not r["full_replay"].get("passed"):
            row["execution"] += 1
        else:
            row["not_replayed"] += 1
        if isinstance(r.get("plain_replay"), dict):
            row["plain_replayed"] += 1
            row["plain_passed"] += bool(r["plain_replay"].get("passed"))
    if not by_behavior:
        return None
    ordered = {b: by_behavior[b] for b in sorted(by_behavior, key=_behavior_key)}
    return {"mode": "per_ticket", "by_behavior": ordered,
            **{k: sum(r[k] for r in ordered.values()) for k in ("tickets",) + kinds}}


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


def agent_correction_summary(results):
    """Agent correction: the customer corrects something support said. It only happens when the bot gets
    a detail wrong, so it is counted wherever it happens: tickets with a correction, and how many of
    those the bot still got right (repair)."""
    corrected = [r for r in results if r.get("customer_corrections")]
    fixed = sum(1 for r in corrected if r.get("passed"))
    return {"tickets": len(corrected), "fixed": fixed, "repair_rate": _pass_rate(fixed, len(corrected)) if corrected else None,
            "by_ticket": [{"id": r["id"], "corrections": r["customer_corrections"], "passed": bool(r.get("passed"))}
                          for r in corrected]}


def nl_summary(results):
    """What the bot told the customer, scored apart from pass/fail.
    strict_score: tickets that passed and made no statement the docs forbid (a credit promise, another customer's
    name), over all tickets. Communication: tickets with no NL issue at all, and each check's count."""
    total = len(results)
    by_key, breaches = {}, []
    for r in results:
        for c in r.get("nl_checks") or []:
            row = by_key.setdefault(c["key"], {"severity": c["severity"], "tickets": []})
            row["tickets"].append(r["id"])
            if c["severity"] == "strict":
                breaches.append({"id": r["id"], "key": c["key"], "detail": c["detail"]})
    strict = sum(1 for r in results if r.get("passed_strict", r.get("passed")))
    clean = sum(1 for r in results if not r.get("nl_checks"))
    return {"tickets": total, "strict_passed": strict, "strict_score": strict / total if total else 0.0,
            "strict_breaches": len(breaches), "breaches": breaches, "tickets_clean": clean,
            "by_check": {k: {"severity": v["severity"], "count": len(v["tickets"]), "tickets": v["tickets"]}
                         for k, v in sorted(by_key.items())}}


NL_NAMES = {"credit promise": "Promised a credit", "refund promise": "Promised a refund", "other customer": "Named another customer",
            "reply time": "Promised a different reply time", "handoff claim": "Said a person took over, no handoff",
            "handoff notice": "Handed off without telling the customer", "clarifying question": "Never asked for missing facts"}


def nl_lines(nl):
    if not nl:
        return []
    lines = ["## What the bot told the customer", "",
             "Checked on every ticket but never fails one: pass/fail is the end state. The strict score also fails "
             "a ticket whose replies promised a credit or named another customer (the docs forbid both).", "",
             f"Strict score: {nl['strict_passed']} / {nl['tickets']} ({nl['strict_score']:.4f}) · "
             f"tickets with no reply issue: {nl['tickets_clean']} / {nl['tickets']}", ""]
    if nl["by_check"]:
        lines += ["| Check | Kind | Tickets |", "| --- | --- | --- |"]
        for key, row in nl["by_check"].items():
            lines.append(f"| {NL_NAMES.get(key, key)} | {row['severity']} | {row['count']} ({', '.join(row['tickets'])}) |")
        lines.append("")
    return lines


def agent_correction_lines(summary):
    if not summary or not summary["tickets"]:
        return []
    return ["## Agent correction", "",
            "The customer corrected something support said in "
            f"{summary['tickets']} ticket(s); the bot still got {summary['fixed']} right "
            f"(repair rate {summary['repair_rate']:.2f}).", ""]


def taxonomy_lines(taxonomy):
    if not taxonomy or not taxonomy.get("records"):
        return []
    lines = ["## Failures by type", "",
             "One type per failed check: builder causes by cause, bot mistakes by what the end state showed. "
             "Limits and faults a test sets on purpose (prompt cap, hidden files) count for the builder or the bot; "
             "Harness is only what we broke.", "",
             "| Party | Family | Type | Count |", "| --- | --- | --- | --- |"]
    order = {"Builder": 0, "Bot": 1, "Harness": 2}
    rows = sorted(taxonomy["by_type"].items(), key=lambda kv: (order.get(kv[1]["party"], 3), kv[1]["family"], -kv[1]["count"]))
    for kind, row in rows:
        lines.append(f"| {row['party']} | {row['family']} | {kind} | {row['count']} |")
    parties = " · ".join(f"{p}: {n}" for p, n in sorted(taxonomy["by_party"].items(), key=lambda kv: order.get(kv[0], 3)))
    return lines + ["", f"Totals: {parties} (of {taxonomy['records']} failed checks)", ""]


def attribution_lines(attribution):
    if not attribution:
        return []
    if attribution.get("mode") == "per_ticket":
        lines = ["## Failures by customer behaviour", "",
                 "Each failed ticket was replayed with the rule stated plainly. Lacked the rule = passed once told, "
                 "the rule had not reached the model (knowledge). Fixed when told / cannot apply = the rule had reached "
                 "the model, or the bot fails even when told (the behaviour or applying the rule). Execution = the full "
                 "replay, with the rule and the customer's information given, failed too. Ours and bot errors "
                 "tested no rule. Plain customer = a ticket that failed even when told the rule, run again with a plain "
                 "customer and no rule; passing then means the behaviour cost the ticket.", "",
                 "| Behaviour | Tickets | Failed | Lacked the rule | Fixed when told | Cannot apply | Execution | Ours "
                 "| Bot errors | Passed with the customer's information given |",
                 "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for b, row in attribution["by_behavior"].items():
            plain = f"{row['plain_passed']}/{row['plain_replayed']}" if row.get("plain_replayed") else "–"
            lines.append(f"| {BEHAVIOR_NAMES.get(b, b)} | {row['tickets']} | {row['failed']} | {row['lacked_rule']} | "
                         f"{row['fixed_when_told']} | {row['cannot_apply']} | {row['execution']} | {row['ours']} | {row['bot_errors']} | {plain} |")
        return lines + [""]
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
    if coverage.get("mode") == "per_ticket":
        lines = ["## Customer behaviour", "",
                 "Every ticket has one customer behaviour; the right filing is the same as for a normal customer. "
                 "Pass rate per behaviour; normal is the baseline. `Qcoverage` is the mean over behaviours.", "",
                 f"**Qcoverage:** {coverage['q_coverage']:.4f} ({coverage['n_behaviors']} behaviours)", "",
                 "| Behaviour | Tickets passed | q |", "| --- | --- | --- |"]
        for b, row in coverage["by_category"].items():
            lines.append(f"| {BEHAVIOR_NAMES.get(b, b)} | {row['passed']} / {row['total']} | {row['q']:.4f} |")
        lines += ["", "| Family | Tickets passed | q |", "| --- | --- | --- |"]
        for fam, row in (coverage.get("by_family") or {}).items():
            lines.append(f"| {fam} | {row['passed']} / {row['total']} | {row['q']:.4f} |")
        return lines + [""]
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
            if diagnose.READ_TOOL.match(str(tool.get("name") or "")):
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


def render_report(results, cases, card=None, bot_files=(), claims=None, subset=None, context=None,
                  coverage=None, realization=None, attribution=None, taxonomy=None, correction=None, nl=None, docs=None,
                  info=None, verdicts=None):
    by_id = {c["id"]: c for c in cases}
    lines = design_lines(claims)
    lines += subset_lines(subset)
    lines += context_lines(context)
    if docs:
        import doc_recall
        lines += doc_recall.doc_lines(docs)
    lines += coverage_lines(coverage, realization)
    lines += attribution_lines(attribution)
    lines += taxonomy_lines(taxonomy)
    lines += info_lines(info)
    lines += verdict_lines(verdicts)
    lines += agent_correction_lines(correction)
    lines += nl_lines(nl)
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


# Labels a ticket must NOT have whose rule still decides the ticket even when the rule is not on it. Skyway has none:
# a forbidden label of another rule (agency-refund on a direct booking...) is a trap, not a rule the ticket tests.
GENERAL_LABEL_RULES = set()


def missing_owner_rules(case, rules):
    """Every field a ticket checks needs one of the rules that decide it (a rule's "checks") on the ticket: the
    replay note, blame and Qknowledge read the ticket's rules, so a missing one leaves the deciding rule out of the
    replay and blames the wrong rule."""
    def owners(key):
        return [rid for rid, r in rules.items() if any(fnmatch.fnmatchcase(key, p) for p in r.get("checks", []))]
    have = set(case.get("rules", []))
    keys = [(diagnose.check_key(path), False) for path in case.get("expect") or {}]
    keys += [(f"labels:{v}", False) for vals in (case.get("contains") or {}).values() for v in vals]
    keys += [(f"labels:{v}", True) for vals in (case.get("not_contains") or {}).values() for v in vals]
    keys += [(spec["call"], False) for spec in case.get("required_calls") or []]
    out = []
    for key, forbidden in dict.fromkeys(keys):
        own = owners(key)
        if not own or have & set(own) or (forbidden and not GENERAL_LABEL_RULES & set(own)):
            continue
        out.append(f"{case['id']}: checks {key} but none of the rules that decide it ({', '.join(sorted(own))}) is on the ticket")
    return out


def cmd_check(args):
    customer.self_check()
    keyword_problems = diagnose.keyword_self_check()
    sys.path.insert(0, str(Path(__file__).resolve().parent / "llm_hook"))
    import prompt_cap
    prompt_cap.self_check()
    cases = {c["id"]: c for c in load_json(args.cases)}
    seed = load_state(Path(args.seed))
    problems = list(keyword_problems)
    app = Path(args.app) if args.app else None

    governed, _ = diagnose.GOVERNED_LABELS
    if set(customer.LABELS) != governed:
        problems.append("customer.LABELS and diagnose.GOVERNED_LABELS differ")
    for case in cases.values():
        for values in list((case.get("contains") or {}).values()) + list((case.get("not_contains") or {}).values()):
            problems += [f"{case['id']}: label {v!r} is not in diagnose.GOVERNED_LABELS" for v in values if v not in governed]
    if args.rules:
        rules = {r["id"]: r for r in load_json(args.rules)}
        for case in cases.values():
            if not case.get("rules"):
                problems.append(f"{case['id']}: has no rules")
            brief = str(case.get("customer") or "").strip()
            if not brief:
                problems.append(f"{case['id']}: has no customer brief")
            elif customer.label_in(brief):
                problems.append(f"{case['id']}: customer brief names a ticket label ({customer.label_in(brief)})")
            for rule_id in case.get("rules", []):
                if rule_id not in rules:
                    problems.append(f"{case['id']}: unknown rule {rule_id}")
            problems += missing_owner_rules(case, rules)
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
            if "replay_passed" in fixture:
                got = sorted({b["blame"] for b in diagnose.apply_replay(
                    [{"blame": g} for g in got], fixture["replay_passed"])})
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
    run.add_argument("--no-replay", action="store_true", help="skip the replay of failed tickets")
    run.add_argument("--workers", type=int, default=WORKERS, help="tickets to run at once")
    run.add_argument("--bot", default=str(BOT))
    run.add_argument("--server", default=str(SERVER))

    rep = sub.add_parser("replay", help="replay a finished step's failed tickets again (live results kept)")
    rep.add_argument("--results", required=True, help="the step's results.json")
    for flag, default in (("--cases", "/tests/cases.json"), ("--seed", "/tests/seed"), ("--data", "/srv/data"),
                          ("--logs", "/logs/verifier"), ("--rules", "/tests/rules.json"), ("--app", "/app"),
                          ("--bot", str(BOT)), ("--server", str(SERVER))):
        rep.add_argument(flag, default=default)
    rep.add_argument("--bot-timeout", type=int, default=240)
    rep.add_argument("--workers", type=int, default=WORKERS, help="tickets to run at once")

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
    one.add_argument("--extra", default=None, help="text appended to the (second) ticket message")
    one.add_argument("--extra-first", default=None, help="text appended to the pair head message")
    one.add_argument("--result-name", default=None, help="key for the result dict (replay uses <id>-replay)")
    one.add_argument("--out", default="/tmp/ticket_result.json")

    check = sub.add_parser("check")
    check.add_argument("--cases", required=True)
    check.add_argument("--seed", required=True)
    check.add_argument("--fixtures", required=True)
    check.add_argument("--rules")
    check.add_argument("--app")
    check.add_argument("--blame-fixtures")

    args = parser.parse_args()
    {"run": cmd_run, "replay": cmd_replay, "run-one": cmd_run_one, "check": cmd_check}[args.cmd](args)


if __name__ == "__main__":
    main()
