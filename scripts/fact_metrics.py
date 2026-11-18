#!/usr/bin/env python3
"""Fact-level metrics for a finished run, from what the run saved: no bot or replay is run again.

    python3 scripts/fact_metrics.py <job dir> [--steps stage0,stage1] [--force [--customer-only]]

Per step (steps/<step>/):
  1. Judge: one model call reads the bot the step was graded with (verifier/bot) and, for every fact in the step's
     facts.json (scripts/build_facts.py), gives evidence, the bot's own lines, where they are, and a verdict:
     present (right) / not-present (absent). A fact in the bot's files counts even if it never reached the
     model. A quote that is not in the bot's files (whitespace and case aside) does not count: the label falls back
     to absent.
  2. Customer facts: a model reads each ticket's conversation and lists which of the ticket's customer facts the
     customer told the bot (the opening counts).
  3. Metrics and blame, per ticket and for the step:
       rule recall      the step's needed facts the bot has / needed facts (per ticket too, for blame and the viewer)
       rule precision   needed facts the bot has / every fact on the list the bot has (needed, trap, stale)
       customer recall  decisive facts the bot got / decisive facts
       customer precision  support turns that seek information and ask for a decisive customer fact / support turns
                        that seek information (per ticket, then averaged)
       blame (failed ticket)  builder when a fact deciding a failed check is not right in the bot; harness when
                        every failure was ours; else agent
Writes steps/<step>/verifier/fact-metrics/{judge.json, customer.json, metrics.json}. The judge and customer files
are reused when present (--force calls the models again); metrics.json is always rebuilt. The run's own files are
not changed, so the old blame and replay verdicts stay where they are for comparison.

Models (litellm): JUDGE_MODEL (default openai/gpt-6.1-sol) and FACTS_MODEL (default openai/gpt-6.1-sol), both at
JUDGE_EFFORT reasoning (default high). Run with a Python that has litellm, with the keys in the environment. In folder
mode an openai/ judge is Codex CLI (codex exec), an anthropic/ judge is Claude Code (claude -p).
"""
import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import failure_types as ft  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-6.1-sol")
FACTS_MODEL = os.environ.get("FACTS_MODEL", "openai/gpt-6.1-sol")
JUDGE_EFFORT = os.environ.get("JUDGE_EFFORT", "high")
MAX_FILE_BYTES = 2_000_000
# JUDGE_MODE=folder: the judge is Claude Code reading the bot's files itself with its Read, Grep and Glob tools, instead
# of getting every file pasted into one prompt (a bot that keeps all ~10,000 company docs is 45 MB, about 11M tokens).
# It runs in a Docker container that holds only a read-only copy of those files, so it cannot reach anything else on
# this machine, whatever the bot's files tell it. JUDGE_MAX_USD caps a stage's judge cost over all its tries.
JUDGE_MODE = os.environ.get("JUDGE_MODE", "paste")
JUDGE_MAX_TURNS = int(os.environ.get("JUDGE_MAX_TURNS", "80"))
JUDGE_MAX_USD = float(os.environ.get("JUDGE_MAX_USD", "10"))
JUDGE_CLAUDE_VERSION = os.environ.get("JUDGE_CLAUDE_VERSION", "2.1.289")
JUDGE_IMAGE = f"fact-judge:{JUDGE_CLAUDE_VERSION}"
JUDGE_DOCKERFILE = f"""FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code@{JUDGE_CLAUDE_VERSION} && npm cache clean --force
RUN useradd -m judge
USER judge
WORKDIR /bot
"""
JUDGE_CODEX_VERSION = os.environ.get("JUDGE_CODEX_VERSION", "0.167.2")
JUDGE_CODEX_IMAGE = f"fact-judge-codex:{JUDGE_CODEX_VERSION}-ca"
# node:22-slim has no CA certificates: Codex (unlike Claude Code) uses the system store, and without it every
# connection to OpenAI fails TLS ("invalid peer certificate: UnknownIssuer") and Codex retries forever.
JUDGE_CODEX_DOCKERFILE = f"""FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@{JUDGE_CODEX_VERSION} && npm cache clean --force
RUN useradd -m judge
USER judge
WORKDIR /bot
"""
BATCH = 4  # conversations per customer-facts call

JUDGE_PROMPT = """You audit the files of a customer-support bot. A builder wrote these files from the company's docs; at
run time the bot answers support tickets using only what is in them.

Below is every rule the docs give (with its decisive value), plus some decoys: old, draft or look-alike versions of
rules. For each one, decide whether the bot's files contain it. A rule is present when the files give the bot the
same decisive value, in any form. It can be incorporated in many ways, for example:
- copied word for word into the system prompt or a reference doc;
- reworded or summarised ("Timeouts get symptom-timeout" for a long paragraph about 504s and deadlines);
- one row or cell of a table or list ("dedicated: P1 30m" for "first response at P1 for a dedicated customer: 30m");
- code: a dict, a mapping, an if-condition, a constant, an enum, a tool's description or arguments;
- spread over two places (a label list in one file, when to use it in another).
It is not present when nothing in the files gives it, when the files only mention the topic without the decisive value,
or when they give the same situation a different value or instruction (another time, label, team or condition).

For each rule, first give the evidence, then the location, then the verdict:
- evidence: very brief: why the rule is or is not there. If the files cover the topic, say what the bot says.
- quote: the bot's lines that show it, copied exactly as they appear in the files, one contiguous passage of at most
  300 characters ("" when not present).
- location: where in the bot: system prompt, reference doc, code, tool description, config, other ("" when not present).
- verdict: present or not-present.

Rules (id: statement [decisive value]):
{facts}

Answer with JSON only, one entry per rule id in the order given:
{{"rules": [{{"id": "...", "evidence": "...", "quote": "...", "location": "...", "verdict": "present|not-present"}}, ...]}}

The bot's files:
{files}"""

FACTS_PROMPT = """You read support conversations. Each ticket below lists the customer's facts (things only the customer
knows; "decisive" ones decide how the ticket must be handled) and the conversation, with every turn numbered: C1, C2...
for the customer and S1, S2... for support.

For each SUPPORT turn, decide whether it seeks information from the customer (asks a question or asks the customer to
send, confirm or check something) and which of the customer facts it asks for. A turn that only answers, informs or
acknowledges does not seek information. A request counts for a fact when the customer's answer to it would give that
fact's content, even in other words (e.g. "Which region is affected?" asks for "It is the dedicated pool in us-east").

For each CUSTOMER FACT, decide whether the customer told it anywhere in the conversation (the opening counts): it counts
when the customer gave its substance, in any wording, spread over several turns or as part of a longer answer; it does
not count when only support guessed it.

Give the reasoning first, then the answer. Answer with JSON only:
{{"tickets": [{{"id": "...",
  "support_turns": [{{"turn": "S1", "reasoning": "<short>", "quote": "<the request, copied exactly from that turn, or ''>",
                     "seeks_info": true|false, "asks_for": [<0-based indexes of the facts it asks for>]}}, ...],
  "facts": [{{"index": 0, "reasoning": "<short>", "told": true|false}}, ...]}}, ...]}}
One entry per ticket, every support turn and every fact once.

{tickets}"""


# The judge only says whether a fact is in the bot's files: right (present) or absent. Wrong versions are facts of their
# own in our list (trap, stale), so holding one shows as that fact being present.
VERDICTS = {"present": "right", "not-present": "absent"}  # any other answer counts as absent


def load(path):
    return json.loads(Path(path).read_text())


def norm(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower()


BINARY_DATA = (".pkl", ".pickle", ".pkl.gz", ".pickle.gz", ".json.gz", ".sqlite", ".sqlite3", ".db")
EXPORT_IMAGE = "bot-export:1"
_EXPORTED = {}


def exported_files(bot):
    """In folder mode, the bot's binary data files (a pickled graph, a gzipped JSON, a SQLite db) as text, so the judge
    can read the facts in them: converted by judge_export/export_binary.py inside a container with no network and
    the bot read-only (unpickling a file the builder wrote can run code). Parts of at most 1.5 MB, under converted/."""
    import subprocess
    import tempfile
    key = str(Path(bot).resolve())
    if key in _EXPORTED:
        return _EXPORTED[key]
    out = []
    if any(p.is_file() and p.name.lower().endswith(BINARY_DATA) for p in Path(bot).rglob("*")):
        here = Path(__file__).resolve().parent / "judge_export"
        if subprocess.run(["docker", "image", "inspect", EXPORT_IMAGE], capture_output=True).returncode:
            subprocess.run(["docker", "build", "-q", "-t", EXPORT_IMAGE, str(here)], check=True, stdout=subprocess.DEVNULL)
        with tempfile.TemporaryDirectory(prefix="bot-export-", dir=os.environ.get("JUDGE_TMP")) as tmp:
            os.chmod(tmp, 0o777)
            run = subprocess.run(["docker", "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp",
                                  "-m", "2g", "--cpus", "2", "-v", f"{key}:/bot:ro", "-v", f"{tmp}:/out", EXPORT_IMAGE,
                                  "python3", "/export_binary.py", "/bot", "/out"],
                                 capture_output=True, text=True, timeout=900)
            print(f"converted binary data in {Path(bot).parent.parent.parent.name}: {run.stdout.strip()[:300]}",
                  file=sys.stderr, flush=True)
            for f in sorted(Path(tmp).rglob("*.txt")):
                out.append(("converted/" + str(f.relative_to(tmp)), f.read_text(errors="replace")))
    _EXPORTED[key] = out
    return out


def bot_files(bot):
    if JUDGE_MODE == "folder":
        return _bot_text_files(bot) + exported_files(bot)
    return _bot_text_files(bot)


def _bot_text_files(bot):
    out = []
    for path in sorted(Path(bot).rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc" or path.stat().st_size > MAX_FILE_BYTES:
            continue
        try:
            out.append((str(path.relative_to(bot)), path.read_text()))
        except (OSError, UnicodeDecodeError):
            continue
    return out


def json_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield str(k)
            yield from json_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from json_strings(v)


def quote_corpus(files):
    """The bot's text as a quote may copy it: the files as written, and for JSON files their decoded strings (a quote
    copies "2 hours.\nThis page" from a JSON value as it reads, not with the escape)."""
    parts = []
    for name, text in files:
        parts.append(text)
        if name.endswith(".json"):
            try:
                parts.extend(json_strings(json.loads(text)))
            except ValueError:
                pass
    return norm("\n".join(parts))


def check_quotes(labels, corpus):
    """Each label stands only if its quote is in the bot's text; else it falls back to absent."""
    for v in labels.values():
        judged, quote = v.get("judged"), v.get("quote") or ""
        found = judged in (None, "absent") or (bool(quote.strip()) and norm(quote) in corpus)
        v["quote_found"] = found
        v["label"] = judged if found and judged else "absent"
    return labels


def ask(model, prompt, tries=3):
    import litellm
    for attempt in range(tries):
        try:
            extra = {"reasoning_effort": JUDGE_EFFORT} if model.startswith("openai/") else {}
            resp = litellm.completion(model=model, messages=[{"role": "user", "content": prompt}], max_tokens=32000,
                                      **extra)
            text = resp.choices[0].message.content or ""
            start = text.find("{")
            parsed = json.JSONDecoder().raw_decode(text[start:])[0] if start >= 0 else None
        except Exception as e:  # a dropped call or cut-off JSON: ask again
            parsed, text = None, f"{type(e).__name__}: {e}"
        if parsed is not None:
            break
        print(f"{model}: attempt {attempt + 1} failed: {text[:200]}", file=sys.stderr, flush=True)
    else:
        raise SystemExit(f"{model}: no usable answer after {tries} tries")
    cost = (resp._hidden_params or {}).get("response_cost")
    usage = getattr(resp, "usage", None)
    return parsed, {"model": model, "cost": cost,
                                    "prompt_tokens": getattr(usage, "prompt_tokens", None),
                                    "completion_tokens": getattr(usage, "completion_tokens", None)}


FOLDER_FILES = """The bot's files are not pasted here: they are in your current folder (/bot). Look at them yourself with
your tools (list them, search them, read them; do not change anything). For each rule, search for its decisive value and its key
words, and try other wordings before you decide it is not there. Copy every quote exactly from what you read. When you
have checked every rule, your final message is the JSON above and nothing else."""


_IMAGE_LOCK = __import__("threading").Lock()


def judge_image(image=None, dockerfile=None):
    """The judge's image, built once (stages are judged in parallel: one builds, the others wait)."""
    import subprocess
    import tempfile
    image, dockerfile = image or JUDGE_IMAGE, dockerfile or JUDGE_DOCKERFILE
    have = lambda: subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0
    with _IMAGE_LOCK:
        if have():
            return image
        with tempfile.TemporaryDirectory() as ctx:
            (Path(ctx) / "Dockerfile").write_text(dockerfile)
            built = subprocess.run(["docker", "build", "-q", "-t", image, ctx], stdout=subprocess.DEVNULL).returncode
        if built and not have():  # another process may have built it meanwhile
            raise SystemExit(f"could not build {image}")
    return image


def ask_codex(model, prompt, files):
    """The judge as Codex CLI (codex exec) in a container with a read-only copy of the bot's files at /bot and nothing
    else of this machine, as ask_claude. Codex's own sandbox is off: inside Docker it cannot start, and the container
    (read-only /bot, no host mounts) is the boundary. Returns (parsed JSON, usage) like ask()."""
    import subprocess
    import tempfile
    key = os.environ.get("OPENAI_API_KEY") or ""
    if not key:
        raise SystemExit("an openai/ folder judge needs OPENAI_API_KEY")
    image = judge_image(JUDGE_CODEX_IMAGE, JUDGE_CODEX_DOCKERFILE)
    name = model.split("/", 1)[-1]  # openai/gpt-6.1-sol -> gpt-6.1-sol
    tries = []
    with tempfile.TemporaryDirectory(prefix="judge-bot-") as tmp:
        for rel, text in files:
            dst = Path(tmp) / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(text)
        os.chmod(tmp, 0o755)
        for attempt in range(3):
            # codex exec does not read OPENAI_API_KEY by itself: log in with it first (inside the container only)
            run = ("printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1 && exec codex exec --json "
                   "--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "
                   f"--model {name} -c model_reasoning_effort={JUDGE_EFFORT} -")
            cmd = ["docker", "run", "--rm", "-i", "-v", f"{tmp}:/bot:ro", "-e", "OPENAI_API_KEY", image,
                   "sh", "-c", run]
            proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=3600)
            raw = proc.stdout.replace(key, "[redacted]")  # never let the key reach a saved file
            text, usage, turns = "", {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}, 0
            for line in raw.splitlines():
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                item = ev.get("item") or {}
                if ev.get("type") == "item.completed" and item.get("type") == "agent_message":
                    text = item.get("text") or text
                if ev.get("type") == "turn.completed":
                    turns += 1
                    for k in usage:
                        usage[k] += (ev.get("usage") or {}).get(k) or 0
            tries.append({"turns": turns, "exit": proc.returncode, **usage})
            start = text.find("{")
            try:
                parsed = json.JSONDecoder().raw_decode(text[start:])[0] if start >= 0 else None
            except ValueError:
                parsed = None
            if parsed is not None:
                return parsed, {"model": model, "mode": "folder", "agent": f"codex {JUDGE_CODEX_VERSION}",
                                "effort": JUDGE_EFFORT, "tries": tries, "prompt_tokens": usage["input_tokens"],
                                "cached_tokens": usage["cached_input_tokens"],
                                "completion_tokens": usage["output_tokens"]}
            err = proc.stderr.replace(key, "[redacted]")[-300:]
            print(f"{model}: codex folder judge attempt {attempt + 1} failed (exit {proc.returncode}): "
                  f"{text[:200] or err}", file=sys.stderr, flush=True)
    raise SystemExit(f"{model}: codex folder judge gave no usable answer after {len(tries)} tries")


def ask_claude(model, prompt, files):
    """The judge as Claude Code (claude -p) in a container with a read-only copy of the bot's files at /bot (the same
    files the paste judge gets: bot_files) and nothing else of this machine. Returns (parsed JSON, usage) like ask()."""
    import subprocess
    import tempfile
    key = os.environ.get("ANTHROPIC_API_KEY") or ""
    if not key:
        raise SystemExit("JUDGE_MODE=folder needs ANTHROPIC_API_KEY")
    image = judge_image()
    name = model.split("/", 1)[-1]  # anthropic/claude-sonnet-5-5 -> claude-sonnet-5-5
    spent, tries = 0.0, []
    with tempfile.TemporaryDirectory(prefix="judge-bot-") as tmp:
        for rel, text in files:
            dst = Path(tmp) / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(text)
        os.chmod(tmp, 0o755)
        for attempt in range(3):
            budget = JUDGE_MAX_USD - spent
            if budget < 0.25:
                break
            cmd = ["docker", "run", "--rm", "-i", "-v", f"{tmp}:/bot:ro", "-e", "ANTHROPIC_API_KEY", image,
                   "claude", "-p", "--model", name, "--tools", "Read,Grep,Glob", "--setting-sources", "",
                   "--strict-mcp-config", "--no-session-persistence", "--output-format", "json",
                   "--max-turns", str(JUDGE_MAX_TURNS), "--max-budget-usd", f"{budget:.2f}"]
            proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=3600)
            # The key is in the container's environment: never let it reach a saved or published file.
            raw = proc.stdout.replace(key, "[redacted]")
            try:
                out = json.loads(raw)
            except ValueError:
                out = {"result": "", "subtype": f"exit {proc.returncode}: {proc.stderr.replace(key, '[redacted]')[-300:]}"}
            cost = out.get("total_cost_usd") or 0
            spent += cost
            tries.append({"cost": cost, "turns": out.get("num_turns"), "subtype": out.get("subtype")})
            text = out.get("result") or ""
            start = text.find("{")
            try:
                parsed = json.JSONDecoder().raw_decode(text[start:])[0] if start >= 0 else None
            except ValueError:
                parsed = None
            if parsed is not None:
                u = out.get("usage") or {}
                return parsed, {"model": model, "mode": "folder", "cost": spent, "tries": tries,
                                "prompt_tokens": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
                                + (u.get("cache_creation_input_tokens") or 0),
                                "completion_tokens": u.get("output_tokens"), "turns": out.get("num_turns"),
                                "seconds": round((out.get("duration_ms") or 0) / 1000)}
            print(f"{model}: folder judge attempt {attempt + 1} failed: {out.get('subtype')} {text[:200]} "
                  f"(spent ${spent:.2f} of ${JUDGE_MAX_USD:.2f})", file=sys.stderr, flush=True)
    raise SystemExit(f"{model}: folder judge gave no usable answer (spent ${spent:.2f} over {len(tries)} tries)")


def judge(bot, facts, mode=None):
    mode = mode or JUDGE_MODE
    files = bot_files(bot)
    listing = "\n".join(f"- {f['id']}: {f['text']}" + (f" [decisive value: {f['value']}]" if f.get("value") else "")
                        for f in facts)
    if mode == "folder":
        folder_judge = ask_codex if JUDGE_MODEL.startswith("openai/") else ask_claude
        answer, usage = folder_judge(JUDGE_MODEL, JUDGE_PROMPT.format(facts=listing, files=FOLDER_FILES), files)
    else:
        body = "\n\n".join(f"=== {name} ===\n{text}" for name, text in files)
        answer, usage = ask(JUDGE_MODEL, JUDGE_PROMPT.format(facts=listing, files=body))
    labels = {}
    for row in answer.get("rules", []):
        labels[row.get("id")] = {"judged": VERDICTS.get(row.get("verdict"), "absent"), "quote": row.get("quote") or "",
                                 "evidence": row.get("evidence", ""), "location": row.get("location", "")}
    check_quotes(labels, quote_corpus(files))
    missing = [f["id"] for f in facts if f["id"] not in labels]
    for fid in missing:
        labels[fid] = {"label": "absent", "judged": None, "quote": "", "quote_found": False, "evidence": "",
                       "location": ""}
    return {"model": JUDGE_MODEL, "usage": usage, "files": [n for n, _ in files], "not_answered": missing,
            "labels": labels}


def customer_lines(conversation):
    """The customer's own lines of a saved conversation: "Customer: ..." blocks, and the opening when it has no prefix
    (the verifier saves a one-message ticket's opening as it is)."""
    blocks = re.split(r"\n\n(?=(?:Customer|Support): )", conversation or "")
    return "\n\n".join(b if b.startswith("Customer: ") else f"Customer: {b}" for i, b in enumerate(blocks)
                         if b.strip() and (b.startswith("Customer: ") or (i == 0 and not b.startswith("Support: "))))


def turns_of(conversation):
    """A saved conversation as numbered turns: [("C1", text), ("S1", text), ...]; an unprefixed opening is the customer's."""
    out, n = [], {"C": 0, "S": 0}
    for i, b in enumerate(re.split(r"\n\n(?=(?:Customer|Support): )", conversation or "")):
        if not b.strip():
            continue
        who = "S" if b.startswith("Support: ") else "C" if (b.startswith("Customer: ") or i == 0) else None
        if who is None:
            continue
        n[who] += 1
        out.append((f"{who}{n[who]}", re.sub(r"^(Customer|Support): ", "", b)))
    return out


def customer_facts(results, tickets):
    """Per ticket: which customer facts the customer told, and each support turn that seeks information with the facts
    it asks for (its quote must be in that turn, else the turn is left out)."""
    jobs = []
    for r in results:
        cf = tickets.get(r["id"], {}).get("customer_facts", [])
        if cf and r.get("conversation"):
            jobs.append((r["id"], cf, turns_of(r["conversation"])))
    out, usage = {}, []

    def run(batch):
        text = "\n\n".join(
            f"### Ticket {tid}\nCustomer facts:\n"
            + "\n".join(f"{i}. {'(decisive) ' if f.get('decisive') else ''}{f['text']}" for i, f in enumerate(cf))
            + "\n\nConversation:\n" + "\n".join(f"[{k}] {t}" for k, t in turns) for tid, cf, turns in batch)
        return ask(FACTS_MODEL, FACTS_PROMPT.format(tickets=text))

    batches = [jobs[i:i + BATCH] for i in range(0, len(jobs), BATCH)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for batch, (answer, u) in zip(batches, pool.map(run, batches)):
            usage.append(u)
            got = {t.get("id"): t for t in answer.get("tickets", [])}
            for tid, cf, turns in batch:
                t = got.get(tid, {})
                texts = [f["text"] for f in cf]
                told = sorted({f["index"] for f in t.get("facts", []) if f.get("told") and isinstance(f.get("index"), int)
                               and 0 <= f["index"] < len(texts)})
                said = dict(turns)
                rows = []
                for st in t.get("support_turns", []):
                    quote, text = st.get("quote") or "", said.get(st.get("turn"), "")
                    seeks = bool(st.get("seeks_info"))
                    found = not seeks or (bool(quote.strip()) and norm(quote) in norm(text))
                    asks = sorted({i for i in st.get("asks_for") or [] if isinstance(i, int) and 0 <= i < len(texts)})
                    rows.append({"turn": st.get("turn"), "reasoning": st.get("reasoning", ""), "quote": quote,
                                 "seeks_info": seeks and found, "quote_found": found,
                                 "asks_for": [texts[i] for i in asks] if seeks and found else []})
                out[tid] = {"told": [texts[i] for i in told], "turns": rows, "answered": tid in got}
    return {"model": FACTS_MODEL, "usage": usage, "tickets": out}


def check_facts(blame_rules, need, labels):
    """The facts deciding one failed check: the needed facts of its rules (R1/R2 narrowed to the ticket's cell)."""
    out = []
    for rid in blame_rules:
        out += [f for f in need if f == rid or f.startswith(rid + ".")]
    return [f for f in out if f in labels]


def ratio(a, b):
    return a / b if b else None


# Old blame labels for a bot that never got to answer because its prompt was over the ticket's cap.
CRASH = {"context overflow"}
# Old blame labels of a failed reply check (what the bot told the customer).
NL_BLAMES = ft.REPLY_IDS


def check_group(key):
    """A failed check's key as the check groups customer facts are tagged with (fact_tags.json "decides")."""
    if key.startswith("labels:") or key in ("priority", "first_response_target", "assigned_team", "escalation_status",
                                            "incident_id", "needs_legal_review", "contract"):
        return key
    if "/handoffs" in key:
        return "handoff"
    if "/comments" in key or key in ("attempt_id", "confirmation_id"):
        return "comment"
    if "api_keys" in key:
        return "api_keys"
    if "/credits" in key:
        return "credits"
    # skyway-air: a forbidden payment call is the same check group as the file it writes
    for call, group in (("/refunds", "refunds"), ("/reimbursements", "reimbursements"), ("/approvals", "approvals"),
                        ("/change", "changes")):
        if key.startswith("POST ") and call in key:
            return group
    if key.startswith("PATCH /tickets"):
        return "ticket_change"
    return key


def check_record(b, c, result_checks):
    """The blame record of one failed check (b: the grader's old record, c: what the facts showed for it), in the
    blame order: builder (fact missing, prompt over cap) -> missing customer info -> the check's own symptom."""
    check, rules = b.get("check"), b.get("rules") or []
    if c["crashed"]:
        return ft.record("context overflow", check, rules, "builder",
                         "The agent's prompt went over this ticket's size cap; the call was refused.")
    if c["not_right"]:
        return ft.record("fact absent", check, rules, "builder", "Not right in the agent: " + ", ".join(c["not_right"]))
    if c["missed_customer_facts"]:
        return ft.record("missed customer fact", check, rules, "bot",
                         "Not obtained: " + "; ".join(c["missed_customer_facts"]))
    kind = b["blame"] if b.get("blame") in ft.REPLY_IDS else \
        ft.symptom(next((x for x in result_checks if x.get("key") == check), None))
    return ft.record(kind, check, rules, "bot", "Facts right in the agent: " + (", ".join(c["facts"]) or "none needed"))


def metrics(step_facts, results, judged, told):
    # Right or absent only (judge files saved before the judge answered present / not-present also hold other labels).
    labels = {fid: "right" if v["label"] == "right" else "absent" for fid, v in judged["labels"].items()}
    kinds = {f["id"]: f["kind"] for f in step_facts["facts"]}
    # What the bot holds, of the step's list (needed facts and their wrong versions; a judge file from an older list
    # may also hold facts no longer on it).
    held = [fid for fid in labels if labels[fid] == "right" and fid in kinds]
    correct_useful = [fid for fid in held if kinds.get(fid) == "rule" and labels[fid] == "right"]
    # Wrong versions (trap, stale), for rule precision per ticket: an old version of one fact (a table cell is its own
    # fact) counts for a ticket needing that fact; a rule's other trap or stale sentences for a ticket needing the rule
    # (build_facts.py keeps them per step the same way).
    dummies = [f for f in step_facts["facts"] if f["kind"] in ("trap", "stale")]
    tickets, tally = {}, {"builder": 0, "agent": 0, "harness": 0}
    # The builder's agent never started: its run program is missing or fails on start, so every ticket of the stage
    # exited non-zero (or could not be started) before any model call, with the same error. That is the build's
    # failure, not the agent's on one ticket. A program that starts but breaks the output contract exits 0 and gets
    # another bot_problem; a crash that differs per ticket, or a provider outage, stays as it was.
    def failed_on_start(r):
        problem = r.get("bot_problem") or ""
        return (not r.get("passed") and not r.get("model_calls")
                and (problem.startswith("The bot crashed (exit code") or problem.startswith("The bot could not be started"))
                and "LLM provider did not respond" not in problem
                and bool(r.get("blame")) and all(isinstance(b, dict) and b.get("blame") == "crashed" for b in r["blame"]))
    errors = {(r.get("bot_stderr_tail") or "").strip() or (r.get("bot_problem") or "") for r in results}
    never_started = bool(results) and all(failed_on_start(r) for r in results) and len(errors) == 1
    for r in results:
        t = step_facts["tickets"].get(r["id"], {})
        need = t.get("rule_facts", [])
        right = [f for f in need if labels.get(f) == "right"]
        need_rules = {f.split(".")[0] for f in need}
        wrong_held = [d["id"] for d in dummies if labels.get(d["id"]) == "right"
                      and (d["replaces"] in need if d.get("replaces") else d.get("rule") in need_rules)]
        cf = t.get("customer_facts", [])
        decisive = [x["text"] for x in cf if x.get("decisive")]
        got = set(told.get(r["id"], {}).get("told", []))
        missed = [x for x in cf if x.get("decisive") and x["text"] not in got]
        got_decisive = [f for f in decisive if f in got]
        questions = [q for q in told.get(r["id"], {}).get("turns", []) if q.get("seeks_info")]
        blame, checks, new = None, [], []
        if not r.get("passed"):
            records = [b for b in r.get("blame") or [] if isinstance(b, dict)]
            ours = lambda b: (b.get("taxonomy") or {}).get("party") == "Harness" or b.get("side") in ("harness", "us") \
                or b.get("blame") in ft.HARNESS_IDS  # noqa: E731
            # The grader marks our own failures side "us" (older records) or party Harness.
            if never_started:
                blame = "builder"
                checks = [{"check": b.get("check"), "facts": [], "not_right": [], "missed_customer_facts": [],
                           "crashed": False, "never_started": True, "blame": "builder"} for b in records]
                stderr = (r.get("bot_stderr_tail") or "").strip().splitlines()
                new = [ft.record("build broken", b.get("check"), b.get("rules") or [], "builder",
                                 "The agent never started on any ticket of this stage"
                                 + (f": {stderr[-1].strip()}" if stderr else "")) for b in records]
            elif records and all(ours(b) for b in records):
                blame = "harness"
                new = [ft.record(ft.harness_id(b), b.get("check"), b.get("rules") or [], "harness", b.get("detail", ""))
                       for b in records]
            else:
                for b in records:
                    if ours(b):
                        new.append(ft.record(ft.harness_id(b), b.get("check"), b.get("rules") or [], "harness",
                                             b.get("detail", "")))
                        continue
                    if b.get("guessed"):
                        # A field the knowledge pack's docs do not decide (support-agent-knowledge Rincomplete): no
                        # builder could store the rule, so a value set there is the agent's guess, not a missing fact.
                        checks.append({"check": b.get("check"), "facts": [], "not_right": [], "missed_customer_facts": [],
                                       "crashed": False, "blame": "agent"})
                        new.append(ft.record("wrong value", b.get("check"), b.get("rules") or [], "bot",
                                             "Set a value these docs do not give; it should leave the field or hand off"))
                        continue
                    if b.get("blame") in ft.CRASH_IDS:
                        # The agent never answered: no fact or customer fact can explain the check.
                        checks.append({"check": b.get("check"), "facts": [], "not_right": [], "missed_customer_facts": [],
                                       "crashed": False, "blame": "agent"})
                        new.append(ft.record(b["blame"], b.get("check"), b.get("rules") or [], "bot", b.get("detail", "")))
                        continue
                    # A reply check (naming another customer, promising a credit...) carries every rule of the ticket;
                    # no fact decides it, so it is the agent's.
                    deciding = [] if b.get("blame") in NL_BLAMES else check_facts(b.get("rules") or [], need, labels)
                    not_right = [f for f in deciding if labels.get(f) != "right"]
                    # The bot's prompt went over the ticket's size cap and the call was refused: the builder's
                    # design could not fit the knowledge, though its files have it (context budget exceeded).
                    crashed = b.get("blame") in CRASH
                    # Only a missed customer fact that decides this check (fact_tags.json "decides") explains it.
                    group = check_group(b.get("check") or "")
                    lost = [x["text"] for x in missed if group in (x.get("decides") or [])]
                    c = {"check": b.get("check"), "facts": deciding, "not_right": not_right,
                         "missed_customer_facts": [] if crashed or not_right else lost, "crashed": crashed,
                         "blame": "builder" if not_right or crashed else "agent"}
                    checks.append(c)
                    new.append(check_record(b, c, r.get("checks") or []))
                blame = "builder" if any(c["blame"] == "builder" for c in checks) else "agent"
            tally[blame] += 1
        tickets[r["id"]] = {
            "passed": bool(r.get("passed")),
            "type": t.get("type"),
            "rule_facts": {f: labels.get(f, "absent") for f in need},
            "rule_recall": ratio(len(right), len(need)),
            # Needed facts held / (needed + the wrong versions of the ticket's rules held), passed or failed.
            "rule_precision": ratio(len(right), len(right) + len(wrong_held)),
            "wrong_versions_held": wrong_held,
            "customer_facts": [{"text": x["text"], "decisive": x.get("decisive"), "told": x["text"] in got,
                                "decides": x.get("decides") or []} for x in cf],
            "customer_recall": ratio(len(got_decisive), len(decisive)),
            # Of the support turns that seek information, the share asking for a decisive customer fact.
            "customer_precision": ratio(sum(any(f in decisive for f in q["asks_for"]) for q in questions), len(questions)),
            "questions": questions,
            "blame": blame,
            "checks": checks,
            # One blame record per failed check, named by scripts/failure_types.py (fact_run.py copies them).
            "records": new,
            "old": {"replay_verdict": r.get("replay_verdict"),
                    "blame": [b.get("blame") for b in r.get("blame") or [] if isinstance(b, dict)]},
        }
    per_kind = {}
    for f in step_facts["facts"]:
        row = per_kind.setdefault(f["kind"], {"right": 0, "absent": 0})
        row[labels.get(f["id"], "absent")] += 1
    recalls = [t["rule_recall"] for t in tickets.values() if t["rule_recall"] is not None]
    precisions = [t["rule_precision"] for t in tickets.values() if t["rule_precision"] is not None]
    needed = [f["id"] for f in step_facts["facts"] if f["kind"] == "rule"]
    crec = [t["customer_recall"] for t in tickets.values() if t["customer_recall"] is not None]
    cpre = [t["customer_precision"] for t in tickets.values() if t["customer_precision"] is not None]
    by_type = {}
    for t in tickets.values():
        if t["type"]:
            row = by_type.setdefault(t["type"], {"passed": 0, "total": 0})
            row["total"] += 1
            row["passed"] += t["passed"]
    return {
        "facts": per_kind,
        "rule_precision": ratio(len(correct_useful), len(held)),
        # The step's needed facts (the union of its tickets' facts) the bot has / needed facts.
        "rule_recall": ratio(sum(labels.get(f) == "right" for f in needed), len(needed)),
        "rule_recall_per_ticket": ratio(sum(recalls), len(recalls)),
        "rule_precision_per_ticket": ratio(sum(precisions), len(precisions)),
        "customer_recall": ratio(sum(crec), len(crec)),
        "customer_precision": ratio(sum(cpre), len(cpre)),
        "blame": tally,
        "by_type": by_type,
        "per_fact": {f["id"]: {"kind": f["kind"], "label": labels.get(f["id"], "absent"),
                               "quote": judged["labels"].get(f["id"], {}).get("quote", ""),
                               "evidence": judged["labels"].get(f["id"], {}).get("evidence", ""),
                               "location": judged["labels"].get(f["id"], {}).get("location", ""),
                               "used_by": f.get("used_by")} for f in step_facts["facts"]},
        "tickets": tickets,
    }


def facts_file(task_dir, step):
    """The step's fact list: a stage's own, a pack's own if it has one, else the task's."""
    tests = task_dir / "tests"
    for own in (tests / "stages" / step / "facts.json", tests / "packs" / step / "facts.json"):
        if own.exists():
            return own
    return tests / "facts.json"


def judged_bot(step_dir):
    """The bot the judge reads. The grader's copy (verifier/bot) leaves out files over 2 MB, such as a pickled graph;
    in folder mode the judge reads the full saved build (artifacts/app/bot) when there is one."""
    full = step_dir / "artifacts" / "app" / "bot"
    return full if JUDGE_MODE == "folder" and full.is_dir() else step_dir / "verifier" / "bot"


def run_step(task_dir, step_dir, force, customer_only=False, judge_only=False):
    out = step_dir / "verifier" / "fact-metrics"
    out.mkdir(parents=True, exist_ok=True)
    step_facts = load(facts_file(task_dir, step_dir.name))
    results = load(step_dir / "verifier" / "results.json")
    jf, cf = out / "judge.json", out / "customer.json"
    bot = judged_bot(step_dir)
    if (force and not customer_only) or not jf.exists():
        jf.write_text(json.dumps(judge(bot, step_facts["facts"]), indent=1) + "\n")
    if (force and not judge_only) or not cf.exists():
        cf.write_text(json.dumps(customer_facts(results, step_facts["tickets"]), indent=1) + "\n")
    judged = load(jf)
    # Quotes are checked again on every run, so a better check needs no new model call.
    check_quotes(judged["labels"], quote_corpus(bot_files(bot)))
    jf.write_text(json.dumps(judged, indent=1) + "\n")
    m = metrics(step_facts, results, judged, load(cf)["tickets"])
    (out / "metrics.json").write_text(json.dumps(m, indent=1) + "\n")
    return m


OLD_BUILDER = {"not kept", "not retrieved", "retrieval", "trap doc", "chose trap doc", "stale copy", "rule buried",
               "context overflow"}
OLD_HARNESS = {"our limit", "our service", "customer fault", "trace lost"}


def old_side(labels):
    if labels and all(l in OLD_HARNESS for l in labels):
        return "harness"
    return "builder" if any(l in OLD_BUILDER for l in labels) else "agent"


def run_report(job, task_dir, steps):
    """One file for the viewer (<job>/fact-metrics.json): per step the summary, every fact with its text and the
    judge's answer, every ticket; and the new blame against the old one, per failed ticket."""
    out = {"judge_model": None, "facts_model": None, "steps": [], "compare": {"old_blame": {}, "replay_verdict": {}}}
    cost = 0.0
    for step_dir in steps:
        fm = step_dir / "verifier" / "fact-metrics"
        m, j, c = load(fm / "metrics.json"), load(fm / "judge.json"), load(fm / "customer.json")
        facts = {f["id"]: f for f in load(facts_file(task_dir, step_dir.name))["facts"]}
        results = {r["id"]: r for r in load(step_dir / "verifier" / "results.json")}
        out["judge_model"], out["facts_model"] = j.get("model"), c.get("model")
        cost += (j.get("usage") or {}).get("cost") or 0
        cost += sum(u.get("cost") or 0 for u in c.get("usage") or [])
        tickets = []
        for tid, t in m["tickets"].items():
            r = results.get(tid, {})
            tickets.append({"id": tid, "title": r.get("title"), "behavior": r.get("behavior"), **t})
            if not t["passed"]:
                for key, value in (("old_blame", old_side(t["old"]["blame"])), ("replay_verdict", t["old"]["replay_verdict"] or "none")):
                    row = out["compare"][key].setdefault(t["blame"], {})
                    row[value] = row.get(value, 0) + 1
        out["steps"].append({
            "name": step_dir.name,
            "passed": sum(t["passed"] for t in m["tickets"].values()),
            "tickets": len(m["tickets"]),
            **{k: m[k] for k in ("rule_recall", "rule_precision", "customer_recall", "customer_precision", "blame",
                                 "by_type", "facts")},
            "per_fact": [{"id": fid, "text": facts.get(fid, {}).get("text", ""), "rule": facts.get(fid, {}).get("rule"),
                          **v} for fid, v in m["per_fact"].items()],
            "ticket_rows": tickets,
        })
    out["cost"] = round(cost, 2)
    (job / "fact-metrics.json").write_text(json.dumps(out, indent=1) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job")
    ap.add_argument("--steps", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--customer-only", action="store_true", help="with --force: call only the customer-facts reader again")
    ap.add_argument("--judge-only", action="store_true", help="with --force: call only the judge again")
    a = ap.parse_args()
    job = Path(a.job).resolve()
    trial = next(p for p in job.iterdir() if (p / "steps").is_dir())
    task_name = trial.name.split("__")[0]
    task_dir = REPO / "tasks" / task_name
    wanted = [s for s in a.steps.split(",") if s]
    steps = [p for p in sorted((trial / "steps").iterdir()) if (p / "verifier" / "results.json").exists()
             and (not wanted or p.name in wanted)]
    done = []
    for step_dir in steps:
        m = run_step(task_dir, step_dir, a.force, a.customer_only, a.judge_only)
        done.append(step_dir)
        f = m["facts"]
        print(f"{step_dir.name}: rule recall {m['rule_recall']}, precision {m['rule_precision']}, "
              f"customer recall {m['customer_recall']}, precision {m['customer_precision']}, blame {m['blame']}, "
              f"facts {f}", flush=True)
    every = [p for p in sorted((trial / "steps").iterdir()) if (p / "verifier" / "fact-metrics" / "metrics.json").exists()]
    run_report(job, task_dir, every)


if __name__ == "__main__":
    sys.exit(main())
