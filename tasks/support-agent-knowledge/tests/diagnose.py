"""Deterministic diagnosis: traces, us/builder/bot blame, and the observed architecture card."""

import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

US, BUILDER, BOT = "us", "builder", "bot"
BLAME_TEXT = {
    "crashed": "the bot crashed or broke the output contract",
    "context overflow": "the bot sent the model more than this ticket's prompt limit and stopped",
    "our limit": "our time limit or a stalled machine stopped the run, so this ticket failed because of us",
    "model call failed": "a model call failed before the bot finished the ticket",
    "no model call": "the bot never asked the model",
    "execution": "the model said the right thing, but the bot did something else",
    "code decided": "the bot's own code made this decision, not the model",
    "no tools": "the builder did not give the model a tool, so the bot's code saved the answer text",
    "retrieval": "the rule never reached the model",
    "not kept": "the builder never stored this rule in the bot",
    "not retrieved": "the rule is stored in the bot, but it never reached the model",
    "trap doc": "only an outdated or wrong doc reached the model",
    "stale copy": "an old copy of a changed doc was used",
    "rule buried": "the rule was in the prompt, but the bot only followed it once it was stated plainly",
    "misapplied rule": "the rule reached the model, but the bot answered wrong",
    "chose trap doc": "the current rule and a trap doc both reached the model; the bot followed the trap",
    "customer fault": "the customer model call failed, so this ticket failed because of us",
    "our service": "the LLM provider did not respond, so this ticket failed because of us",
}
BLAME_SIDE = {
    "crashed": BOT, "context overflow": BOT, "our limit": US, "our service": US, "model call failed": BOT, "no model call": BOT,
    "execution": BOT, "code decided": BUILDER, "retrieval": BOT, "not retrieved": BOT,
    "trap doc": BOT, "stale copy": BOT, "rule buried": BOT,
    "misapplied rule": BOT, "chose trap doc": BOT,
    "not kept": BUILDER, "no tools": BUILDER,
    "customer fault": US,
}
HANG_SECONDS = 90


def normalize(text):
    text = str(text).replace("\\n", " ").replace("\\t", " ").replace("’", "'").replace("‘", "'")
    text = text.replace("“", '"').replace("”", '"').replace("\\\"", '"')
    text = re.sub(r"[*`#_\\]", "", text.lower())
    return " ".join(text.split())


def json_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from json_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from json_strings(v)


# ---------- traces ----------

def load_trace(path):
    events = []
    for line in Path(path).read_text().splitlines() if Path(path).exists() else []:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


def model_calls(trace):
    return [e for e in trace if e.get("kind") == "llm"]


def message_text(message):
    if not isinstance(message, dict):
        return str(message)
    content = message.get("content")
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    parts = [str(content or "")]
    for call in message.get("tool_calls") or []:
        fn = call.get("function", call) if isinstance(call, dict) else {}
        parts.append(f"{fn.get('name')} {fn.get('arguments')}")
    return " ".join(parts)


class Corpus(str):
    """Normalized text that also keeps its statements: the lines of each file or message, normalized one by one, so
    rule keywords never match across a line, file or message boundary (normalize joins them)."""
    def __new__(cls, parts):
        lines = [line for part in parts for line in str(part).replace("\\n", "\n").splitlines()]
        obj = super().__new__(cls, normalize(" ".join(lines)))
        obj.statements = [n for n in (normalize(line) for line in lines) if n]
        return obj


def prompt_corpus(calls):
    return Corpus([message_text(m) for c in calls for m in (c.get("messages") or [])])


def reply_corpus(calls):
    parts = []
    for c in calls:
        reply = c.get("reply") or {}
        parts.append(str(reply.get("content") or ""))
        parts += [f"{t.get('name')} {t.get('arguments')}" for t in reply.get("tool_calls", [])]
    return " ".join(parts)


def tool_corpus(calls):
    """Tool name and arguments only. The answer text does not count as a decision."""
    parts = []
    for c in calls:
        reply = c.get("reply") or {}
        parts += [f"{t.get('name')} {t.get('arguments')}" for t in reply.get("tool_calls", [])]
    return " ".join(parts)


READ_TOOL = re.compile(r"^(search|get|list|read|lookup|look_up|find|fetch|query|retrieve|show|view)", re.IGNORECASE)


def write_tool_corpus(calls):
    """Like tool_corpus, without lookup tools: a search query is not a decision to save anything."""
    parts = []
    for c in calls:
        reply = c.get("reply") or {}
        parts += [f"{t.get('name')} {t.get('arguments')}" for t in reply.get("tool_calls", [])
                  if not READ_TOOL.match(str(t.get("name") or ""))]
    return " ".join(parts)


def content_corpus(calls):
    return " ".join(str((c.get("reply") or {}).get("content") or "") for c in calls)


def mentions(text, value):
    return re.search(rf"(?<![A-Za-z0-9-]){re.escape(str(value))}(?![A-Za-z0-9-])", text, re.IGNORECASE) is not None


def label_said(text, value):
    """A label counts as said only as a quoted value, exactly as written. A team name like "Cloud" is not the label "cloud"."""
    return re.search(rf"[\"'`]{re.escape(str(value))}[\"'`]", text) is not None


# ---------- docs ----------

class Docs:
    def __init__(self, app_dir):
        self.app_dir = Path(app_dir)
        self.cache = {}

    @staticmethod
    def rel(source):
        s = str(source).strip().lstrip("./")
        s = s.removeprefix("app/")
        if not s.startswith("docs/"):
            s = "docs/" + s
        return s

    def text(self, source):
        rel = self.rel(source)
        if rel not in self.cache:
            path = self.app_dir / rel
            try:
                raw = path.read_text()
                try:
                    self.cache[rel] = normalize(" ".join(json_strings(json.loads(raw))))
                except json.JSONDecodeError:
                    self.cache[rel] = normalize(raw)
            except OSError:
                self.cache[rel] = None
        return self.cache[rel]


# ---------- changes: whether the model said the value ----------

WRITE_CALLS = ["PATCH /tickets/*", "POST /api_keys/*/disable", "POST /credits", "POST /handoffs"]


def call_of(request):
    return f"{request['method']} {request['path'].split('?')[0]}"


def writes(requests):
    """Successful requests that changed data."""
    return [r for r in requests if r.get("status", 200) < 400
            and any(fnmatch.fnmatchcase(call_of(r), p) for p in WRITE_CALLS)]


def changed_fields(request):
    """[(field, value, rule check keys)] for one change; POST actions use the field name 'action'."""
    call, body = call_of(request), request.get("body") or {}
    if request["method"] == "PATCH":
        out = []
        for field, value in body.items():
            keys = [f"labels:{v}" for v in value] if field == "labels" and isinstance(value, list) else [field]
            out.append((field, value, keys))
        return out
    if call.endswith("/disable"):
        return [("action", request["path"].split("/")[2], [call])]
    if call == "POST /credits":
        return [("action", body.get("amount_usd"), [call])]
    return [("action", body.get("reason"), [call])]


def asked_by_model(field, value, said, prose=False):
    """Did this text carry the value? For a saved change, `said` is the write tool calls only.
    prose=True (the model's reply text) also accepts sentences like "legal review: yes"."""
    if isinstance(value, bool):
        # The field and this value together, as JSON ("needs_legal_review": true) or prose
        # ("needs legal review is true", "legal review: yes"), not just the field name.
        names = {field, field.removeprefix("needs_")}
        if prose:
            words = "true|yes" if value else "false|no"
            names |= {n.replace("_", " ") for n in names}
            link = r"[\"']?\s*(?:[:=]|->|→|\bis\b|\bto\b|\bset to\b|\bshould be\b)\s*[\"']?"
        else:
            words = "true" if value else "false"
            link = r"[\"']?\s*[:=]\s*"
        return any(re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}{link}(?:{words})\b", said, re.IGNORECASE)
                   for name in names)
    if isinstance(value, list):
        return all(asked_by_model(field, v, said, prose) for v in value)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value is not None and mentions(said, value)


SOURCES = ("model", "text", "code")


def change_sources(requests, calls):
    """Who decided each saved change. A note only: it never fails a ticket.
    model = in a tool call; text = only in the model's reply text, which the code copied (no tools);
    code = the model never said it (code decided)."""
    tools, text = write_tool_corpus(calls), content_corpus(calls)
    out = []
    for r in writes(requests):
        for field, value, _ in changed_fields(r):
            source = ("model" if asked_by_model(field, value, tools)
                      else "text" if asked_by_model(field, value, text, prose=True) else "code")
            out.append({"call": call_of(r), "field": field, "value": value, "source": source})
    return out


def not_from_model(requests, calls):
    """Saved changes the model did not make with a tool call. in_answer means it was only in the text."""
    return [{**c, "in_answer": c["source"] == "text"} for c in change_sources(requests, calls) if c["source"] != "model"]


def source_summary(results):
    """Per-run split of who decided the saved changes, and every change the code decided."""
    counts = dict.fromkeys(SOURCES, 0)
    code = []
    for r in results:
        for c in r.get("change_sources") or []:
            counts[c["source"]] += 1
            if c["source"] == "code":
                code.append({"ticket": r.get("id"), "call": c["call"], "field": c["field"], "value": c["value"]})
    return {**counts, "total": sum(counts.values()), "code_decided": code}


def source_split(summary):
    """'62% model, 30% code, 8% text (no tools)' for the report."""
    total = summary["total"]
    if not total:
        return "none"
    names = {"model": "model", "code": "code", "text": "text (no tools)"}
    return ", ".join(f"{round(100 * summary[k] / total)}% {names[k]}" for k in ("model", "code", "text") if summary[k])



# ---------- labels a rule assigns ----------

# A ticket must carry exactly the rule-assigned labels its case expects: an extra one is a
# wrong filing. None = every label is rule-assigned. Otherwise (exact names, prefixes);
# labels outside that set (free topic labels the docs allow) are not graded.
GOVERNED_LABELS = ({"escalated", "security-incident", "symptom-timeout", "symptom-request-timeout"},
                   ("offering-",))  # only labels the docs name; other symptom/topic labels stay allowed


# An escalation as the docs define it, besides priority P0/P1 (escalation-classification page).
ESCALATION_STATUSES = ("Eng engaged", "Incident declared")  # on-call engaged or incident workflow


def is_governed(label):
    if GOVERNED_LABELS is None:
        return True
    names, prefixes = GOVERNED_LABELS
    return label in names or str(label).startswith(prefixes)


def unexpected_labels(case, state, lookup):
    """[(path, label, labels)] for rule-assigned labels on the ticket that the case does not expect.
    Labels the case explicitly forbids are left to not_contains; may_contain labels are allowed."""
    path = f"tickets.{case['input']['ticket_id']}.labels"
    found, got = lookup(state, path)
    if not found or not isinstance(got, list):
        return []
    expected = set(case.get("contains", {}).get(path, [])) | set(case.get("may_contain", {}).get(path, []))
    forbidden = set(case.get("not_contains", {}).get(path, []))
    # One primary symptom: once the case requires a symptom label, any other symptom label is extra.
    one_symptom = any(str(e).startswith("symptom-") for e in case.get("contains", {}).get(path, []))
    # escalated and the offering label follow from the priority (P0/P1). When the case does not
    # check the priority, the docs leave it open, so those labels are not graded here either.
    priority = f"tickets.{case['input']['ticket_id']}.priority"
    priority_open = priority not in case.get("expect", {}) and priority not in (case.get("must_not") or {})
    ticket = (state.get("tickets") or {}).get(case["input"]["ticket_id"]) or {}
    filed_as_escalation = (ticket.get("priority") in ("P0", "P1")
                           or ticket.get("escalation_status") in ESCALATION_STATUSES)

    def graded(v):
        if priority_open and filed_as_escalation and (v == "escalated" or str(v).startswith("offering-")):
            return False
        return is_governed(v) or (one_symptom and str(v).startswith("symptom-"))
    return [(path, v, got) for v in got if v not in expected and v not in forbidden and graded(v)]


# ---------- failed checks and blame ----------

def failed_checks(case, state, requests, seed, lookup, calls=None, model_requests=None, all_requests=None):
    """Structured failures: one dict per failed check. calls=None skips the model-decision check.
    model_requests = writes compared to this start's model; defaults to requests.
    all_requests = the whole sandbox log when a follow-up needs the first write's attempt_id."""
    out = []
    writes = requests if model_requests is None else model_requests
    for path, want in case.get("expect", {}).items():
        found, got = lookup(state, path)
        got = got if found else None
        if got != want:
            file, record_id, field = path.split(".", 2)
            key = file if file == "api_keys" else field
            untouched = got == lookup(seed, path)[1]
            out.append({"kind": "expect", "key": key, "path": path, "want": want, "got": None if untouched else got})
    for path in case.get("unknown_fields", []):  # a field the pack's docs no longer decide (verify.pack_cases)
        found, got = lookup(state, path)
        if found and got is not None and got != lookup(seed, path)[1]:
            out.append({"kind": "guessed", "key": path.split(".", 2)[2], "path": path, "got": got})
    for path, values in case.get("contains", {}).items():
        found, got = lookup(state, path)
        got = got if found and isinstance(got, list) else []
        for v in values:
            if v not in got:
                out.append({"kind": "missing", "key": f"labels:{v}", "path": path, "value": v, "got": got})
    for path, values in case.get("not_contains", {}).items():
        found, got = lookup(state, path)
        got = got if found and isinstance(got, list) else []
        for v in values:
            if v in got:
                out.append({"kind": "extra", "key": f"labels:{v}", "path": path, "value": v, "got": got})
    for path, v, got in unexpected_labels(case, state, lookup):
        out.append({"kind": "extra", "key": f"labels:{v}", "path": path, "value": v, "got": got})
    for file in case.get("unchanged", []):
        if state.get(file) != seed.get(file):
            out.append({"kind": "changed", "key": file, "path": file})
    for pattern in case.get("forbidden_calls", []):
        made = [r for r in requests if fnmatch.fnmatchcase(f"{r['method']} {r['path'].split('?')[0]}", pattern)]
        if made:
            out.append({"kind": "forbidden", "key": pattern, "path": pattern,
                        "calls": [f"{r['method']} {r['path']}" for r in made]})
    for path, fields in case.get("no_refile", {}).items():
        made = refiled(requests, path, fields)
        if made:
            out.append({"kind": "forbidden", "key": made[0][0], "path": made[0][0],
                        "calls": [f"{call} ({', '.join(keys)})" for call, keys in made]})
    for spec in case.get("required_calls", []):
        if not any(call_matches(r, spec) for r in requests):
            out.append({"kind": "required", "key": spec["call"], "path": spec["call"], "want": spec.get("body", {})})
    spec = case.get("require_attempt")
    if spec:
        aid = None
        for request in (all_requests if all_requests is not None else requests):
            if request.get("status", 200) >= 400:
                continue
            if not call_matches(request, {"call": spec["call"]}):
                continue
            aid = (request.get("response") or {}).get("attempt_id")
            if aid:
                break
        texts = []
        for path in spec.get("in") or []:
            found, got = lookup(state, path)
            if not found or got is None:
                continue
            items = got if isinstance(got, list) else [got]
            for item in items:
                texts.append(str(item.get("body") if isinstance(item, dict) else item))
        if not aid:
            out.append({"kind": "required", "key": "attempt_id", "path": spec["call"], "want": spec["call"]})
        elif not any(str(aid) in text for text in texts):
            out.append({"kind": "missing", "key": "attempt_id", "path": spec["call"], "value": aid})
    return out


def refiled(requests, path, fields):
    """[(call, keys)] for PATCHes of the record at path that send any of fields (any status).
    no_refile: a ticket that is already filed must not be filed again, even with the same values."""
    file, record_id = path.split(".", 1)
    target = f"PATCH /{file}/{record_id}"
    out = []
    for r in requests:
        if call_of(r) == target:  # an attempt counts even if the API rejected it
            keys = [k for k in fields if k in (r.get("body") or {})]
            if keys:
                out.append((target, keys))
    return out


def call_matches(request, spec):
    call = call_of(request)
    body = request.get("body") or {}
    return (fnmatch.fnmatchcase(call, spec["call"]) and request.get("status", 200) < 400
            and all(body.get(k) == v for k, v in spec.get("body", {}).items()))


def candidate_rules(case, check, rules_by_id):
    ids = [rid for rid in case.get("rules", []) if rid in rules_by_id]
    hits = [rid for rid in ids if any(fnmatch.fnmatchcase(check["key"], p) for p in rules_by_id[rid].get("checks", []))]
    return hits or ids


# Words that show a rule is there even when the builder rewrote it (tests/rule_keywords.json). Builders often keep the
# docs in their own words, so a rule's evidence sentence alone misses rules the bot does have.
_KEYWORDS_FILE = Path(__file__).resolve().parent / "rule_keywords.json"
_KEYWORDS = json.loads(_KEYWORDS_FILE.read_text()) if _KEYWORDS_FILE.exists() else {}
RULE_KEYWORDS = {k: v for k, v in _KEYWORDS.items() if not k.startswith("_")}
# Rules that apply to almost every ticket (severity, the reply-time table, labels, handoff...). Bots keep them, so
# when a failed field also has a ticket-specific rule, that rule alone decides whether the knowledge was there.
GENERAL_RULES = set(_KEYWORDS.get("_general", []))


# Process rules a check names for almost any field (handoff, "already filed", untrusted text, half-done writes):
# they only decide when nothing else does.
CATCH_ALL_RULES = set(_KEYWORDS.get("_catch_all", []))
# ...except on tickets that test them: untrusted customer text (R15) is the rule of a bad-actor ticket.
SPECIFIC_IN_GROUP = _KEYWORDS.get("_specific_in_group", {})


def deciding_rules(rule_ids, group=None):
    """The rules that decide whether a failed check's knowledge was there: the ticket-specific ones among its
    candidate rules; else the general ones other than the catch-all rules; else all of them."""
    own = {r for r in rule_ids if group in SPECIFIC_IN_GROUP.get(r, [])}
    specific = [r for r in rule_ids if r in own or (r not in GENERAL_RULES and r not in CATCH_ALL_RULES)]
    general = [r for r in rule_ids if r in GENERAL_RULES and r not in CATCH_ALL_RULES]
    return specific or general or list(rule_ids)
STATEMENT_SPLIT = re.compile(r"(?<!\d)[.;](?!\d)|\s[-*\u2022]\s|\|")


def rule_keywords_found(rid, text, within=None):
    """The rule's keywords in one statement of the text (split at sentence ends, semicolons, bullets, table cells),
    and none of its wrong-version phrases anywhere. With `within` (the bot's stored text), the statement must also be
    in it: a prompt also holds the customer's words and API data, which are not the bot's knowledge.
    False when the rule has no keywords."""
    spec = RULE_KEYWORDS.get(rid)
    def has(alt, s):
        return re.search(alt[3:], s) is not None if alt.startswith("re:") else alt in s
    if not spec or any(has(n, text) for n in spec.get("not", [])):
        return False
    for line in getattr(text, "statements", None) or [text]:
        for s in STATEMENT_SPLIT.split(line):
            if 8 < len(s.strip()) <= 500 and all(any(has(a, s) for a in group) for group in spec["all"]) \
                    and (within is None or s.strip() in within):
                return True
    return False


def rule_found(rid, rules_by_id, text, key="evidence", keywords=True, within=None):
    """A rule's evidence sentence in the (normalized) text, or for the current rule its keywords."""
    if any(normalize(e) in text for e in rules_by_id[rid].get(key, []) if str(e).strip()):
        return True
    return keywords and key == "evidence" and rule_keywords_found(rid, text, within)


def rule_reached(rule_ids, rules_by_id, prompts, stored=None, keywords=True):
    """(current rule reached the model, a trap doc reached the model, text from before a doc change reached the model)"""
    def seen(key):
        return any(rule_found(rid, rules_by_id, prompts, key, keywords, stored) for rid in rule_ids)
    return seen("evidence"), seen("trap_evidence"), seen("stale_evidence")


def rules_stored(rule_ids, rules_by_id, stored, keywords=True):
    """True when every rule is in the bot's stored text: an evidence sentence, or its keywords."""
    for rid in rule_ids:
        if rules_by_id[rid].get("evidence") and not rule_found(rid, rules_by_id, stored, keywords=keywords):
            return False
    return True


def blame_check(check, rule_ids, rules_by_id, calls, stored=None, group=None):
    if not calls:
        return "no model call", ""
    if check["kind"] == "not_from_model":
        if check.get("in_answer"):
            return "no tools", f"{check['field']} = {check['value']} was only in the answer text. The builder did not give the model a tool."
        return "code decided", f"The model never said {check['field']} = {check['value']}."
    replies = reply_corpus(calls)
    if check["kind"] == "expect" and not isinstance(check["want"], bool):
        want_said, got_said = mentions(replies, check["want"]), check["got"] is not None and mentions(replies, check["got"])
        if want_said and not got_said:
            return "execution", f"The model said {check['want']}, but the bot set {check['got']}."
        if check["got"] is not None and not got_said:
            return "code decided", f"'{check['got']}' never appears in the model's replies."
    elif check["kind"] == "missing" and label_said(replies, check["value"]):
        return "execution", f"The model said {check['value']}, but the bot did not set it."
    elif check["kind"] == "extra" and not label_said(replies, check["value"]):
        return "code decided", f"'{check['value']}' never appears in the model's replies."
    elif check["kind"] == "required":
        want = check["want"] if isinstance(check["want"], dict) else {}  # attempt_id checks carry a call name
        said = [v for k, v in want.items() if k != "ticket_id" and mentions(replies, v)]
        if said:
            return "execution", f"The model said {said[0]}, but the bot did not do it."
    deciding = deciding_rules(rule_ids, group)
    # Keywords only when a rule really covers the failed field: otherwise candidate_rules falls back to every rule of
    # the ticket, and a general rule's keywords would stand in for knowledge the field never had.
    keywords = any(fnmatch.fnmatchcase(check["key"], p) for rid in rule_ids for p in rules_by_id[rid].get("checks", []))
    current, trap, stale = rule_reached(deciding, rules_by_id, prompt_corpus(calls), stored, keywords)
    if stale:
        return "stale copy", ""
    if not current:
        if trap:
            return "trap doc", ""
        if stored is None:
            return "retrieval", ""
        if rules_stored(deciding, rules_by_id, stored, keywords):
            return "not retrieved", ""
        return "not kept", ""
    return ("chose trap doc", "") if trap else ("misapplied rule", "")


def blame_record(check, rules, label, detail="", side=None):
    return {"check": check, "rules": rules, "blame": label, "detail": detail, "side": side or BLAME_SIDE[label]}


def apply_replay(blame, replay_passed):
    """If the bot follows the rule once it is stated plainly in the ticket, it had the rule and buried it."""
    if replay_passed:
        for b in blame:
            if b["blame"] in ("misapplied rule", "chose trap doc"):
                b["blame"] = "rule buried"
                b["side"] = BLAME_SIDE["rule buried"]
    return blame


def llm_provider_down(*parts):
    """True only when the LLM provider itself did not answer. A local API connection failure stays on the bot."""
    blob = " ".join(str(part or "") for part in parts).lower()
    from_provider = any(token in blob for token in (
        "litellm", "openaiexception", "apiconnectionerror", "anthropic",
    ))
    no_answer = any(token in blob for token in (
        "connection error", "connection reset", "connection refused",
        "connect timeout", "connecterror", "the llm provider did not respond",
    ))
    # The account ran out of credits or quota: our account, not the bot.
    no_account = any(token in blob for token in (
        "no credits remaining", "insufficient_quota", "exceeded your current quota", "credit balance is too low",
    ))
    return from_provider and (no_answer or no_account)


def call_error_record(calls):
    """A failed model call. A hang past 90s is our stalled run. The LLM provider not answering is ours. Anything shorter is the bot, including its own timeout."""
    errors = [c for c in calls if c.get("error")]
    if not errors:
        return None
    seconds = [c.get("seconds") for c in errors if isinstance(c.get("seconds"), (int, float))]
    hung = any(s > HANG_SECONDS for s in seconds) and not any(s <= HANG_SECONDS for s in seconds)
    if any(llm_provider_down(c.get("error")) for c in errors):
        label = "our service"
    elif hung:
        label = "our limit"
    elif all(context_overflow(c.get("error")) for c in errors):
        label = "context overflow"
    else:
        label = "model call failed"
    detail = f"{len(errors)} of {len(calls)} model calls failed: {errors[0]['error'][:160]}"
    return blame_record("all", [], label, detail)


CONTEXT_OVERFLOW = ("maximum context length", "context_length_exceeded", "prompt is too long")


def context_overflow(text):
    """True when the bot stopped because its prompt went over the model's (or the case's) token limit."""
    blob = str(text or "").lower()
    return any(t in blob for t in CONTEXT_OVERFLOW)


def blame_case(case, checks, rules_by_id, calls, bot_problem, stored=None, stderr=""):
    if isinstance(stored, str) and not isinstance(stored, Corpus):
        stored = normalize(stored)
    if bot_problem:
        if "did not finish within" in bot_problem:
            label = "our limit"
        elif llm_provider_down(bot_problem):
            label = "our service"
        elif context_overflow(stderr) or context_overflow(bot_problem):
            label = "context overflow"
        else:
            label = "crashed"
        return [blame_record("contract", case.get("rules", []), label, bot_problem)]
    failed_call = call_error_record(calls)
    if failed_call:
        return [failed_call]
    out = []
    for check in checks:
        rule_ids = candidate_rules(case, check, rules_by_id)
        if check["kind"] == "guessed":
            # The pack's docs do not give this value, so no builder could store it: setting one is the agent's guess.
            rec = blame_record(check["key"], rule_ids, "misapplied rule",
                               f"set {check['got']!r}, a value these docs do not give (it should leave it or hand off)", BOT)
            rec["guessed"] = True  # fact_metrics.py: the agent's, whatever the judge found about the missing rule
            out.append(rec)
            continue
        label, detail = blame_check(check, rule_ids, rules_by_id, calls, stored, case.get("group"))
        side = BLAME_SIDE[label]
        if label == "stale copy" and stored is not None and not rules_stored(rule_ids, rules_by_id, stored):
            side = BUILDER
        out.append(blame_record(check["key"], rule_ids, label, detail, side))
    return out


def replay_note(case, checks, rules_by_id):
    """The rule text the RQ2 replay gives the bot: verify.replay_hint wraps it, and the trace hook appends it to the
    end of the bot's own system message on every model call."""
    ids = []
    for check in checks:
        if check.get("kind") == "guessed":
            continue  # the pack's docs do not give this rule, and the ticket must not use it (verify.pack_cases)
        ids += [r for r in candidate_rules(case, check, rules_by_id) if r not in ids]
    return ids, "Company policy that applies to this ticket: " + " ".join(rules_by_id[r]["rule"] for r in ids)


# ---------- the subset of R the bot kept ----------

def stored_corpus(bot_dir):
    """Normalized text of everything the builder stored under the bot folder."""
    bot_dir = Path(bot_dir)
    parts = []
    if not bot_dir.is_dir():
        return ""
    for path in bot_dir.rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        try:
            if path.stat().st_size > SNAPSHOT_MAX_BYTES:
                continue
            parts.append(path.read_text())
        except (OSError, UnicodeDecodeError):
            continue
    return Corpus(parts)


def doc_coverage(stored, docs_dir):
    """Fraction of the company docs whose text appears in the bot's stored files."""
    docs_dir = Path(docs_dir)
    if not stored or not docs_dir.is_dir():
        return 0.0
    probes = []
    for path in docs_dir.rglob("*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_size > SNAPSHOT_MAX_BYTES:
                continue
            text = normalize(path.read_text())
        except (OSError, UnicodeDecodeError):
            continue
        if len(text) < 80:
            continue
        step = max(80, len(text) // 5)
        for i in range(0, len(text) - 79, step):
            probes.append(text[i:i + 80])
    if not probes:
        return 0.0
    return sum(probe in stored for probe in probes) / len(probes)


def context_summary(results, rules_by_id):
    """For tickets with a prompt cap: tokens sent, right sentence in, cousin in. Not a score."""
    rows = []
    for r in results:
        cap = r.get("prompt_cap_tokens")
        if not cap:
            continue
        calls = r.get("model_calls") or []
        prompts = prompt_corpus(calls)
        tokens = [c.get("prompt_tokens") for c in calls if isinstance(c.get("prompt_tokens"), int)]
        if not tokens:
            tokens = [max(1, len(prompt_corpus([c])) // 4) for c in calls]
        rule_ids = [rid for rid in r.get("rules") or [] if rid in rules_by_id]
        right = any(
            normalize(e) in prompts
            for rid in rule_ids for e in rules_by_id[rid].get("evidence", []) if str(e).strip()
        )
        cousin = any(
            normalize(e) in prompts
            for rid in rule_ids for e in rules_by_id[rid].get("trap_evidence", []) if str(e).strip()
        )
        rows.append({
            "id": r["id"],
            "cap": cap,
            "max_tokens": max(tokens) if tokens else 0,
            "calls": len(calls),
            "right": right,
            "cousin": cousin,
            "passed": r.get("passed"),
        })
    return rows


def subset_summary(rules, bot_dir, prompts):
    """How many rule sentences the bot kept, and how many reached the model.
    How much of the full docs it copied needs the docs: scripts/docs_report.py."""
    stored = stored_corpus(bot_dir)
    kept = reached = kept_not_reached = total = 0
    for rule in rules:
        sentences = [normalize(s) for s in rule.get("evidence", []) if str(s).strip()]
        if not sentences:
            continue
        total += 1
        k = any(s in stored for s in sentences)
        seen = any(s in prompts for s in sentences)
        kept += k
        reached += seen
        kept_not_reached += k and not seen
    return {
        "rules": total,
        "kept": kept,
        "reached": reached,
        "kept_not_reached": kept_not_reached,
    }


# ---------- observed architecture ----------

def baseline_imports(hook_dir, trace_path):
    """Third-party modules imported just by loading litellm and requests (not a builder decision)."""
    trace_path = Path(trace_path)
    trace_path.write_text("")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": str(hook_dir), "OBSERVE_TRACE": str(trace_path)}
    subprocess.run([sys.executable, "-c", "import litellm, requests"], env=env, capture_output=True, timeout=120)
    return {e["module"] for e in load_trace(trace_path) if e.get("kind") == "import"} | {"sitecustomize"}


CODE_SUFFIXES = (".py", ".sh", ".js", ".mjs", ".ts")


EMBEDDING_CALL = re.compile(r"\ba?embedding\s*\(")


def embeddings_in_code(bot_dir):
    """Python files under the bot that call (a)embedding(. A code check, used for the RQ3 class
    only when a run has no runtime trace to count real embedding calls."""
    out = []
    for p in sorted(Path(bot_dir).rglob("*.py")):
        try:
            if EMBEDDING_CALL.search(p.read_text(errors="ignore")):
                out.append(str(p.relative_to(bot_dir)))
        except OSError:
            continue
    return out


def architecture_card(results, baseline, bot_dir="/app/bot"):
    bot_dir = str(Path(bot_dir).resolve())
    # Count LLM calls from model_calls (always kept). Daytona run-one strips
    # bulky "trace" before returning to the orchestrator.
    def ticket_calls(r):
        mc = r.get("model_calls")
        if isinstance(mc, list):
            return mc
        tr = r.get("trace")
        if isinstance(tr, list) and tr:
            return model_calls(tr)
        return []
    def ticket_trace(r):
        tr = r.get("trace")
        return tr if isinstance(tr, list) else []
    tickets = [r for r in results if isinstance(r, dict) and ("model_calls" in r or "trace" in r)]
    calls_per = [len(ticket_calls(r)) for r in tickets]
    # The bot runs once per customer message. A run is its start-to-end window (any child process the bot starts
    # counts with it); results without the windows group calls by process instead.
    def run_sizes(r):
        cs = ticket_calls(r)
        windows = r.get("bot_runs") or []
        if windows:
            sizes = [0] * len(windows)
            for c in cs:  # a call's time is when it finished; each call goes to the first window that holds it
                i = next((k for k, w in enumerate(windows) if w["start"] <= (c.get("t") or 0) <= w["end"] + 1), None)
                if i is not None:
                    sizes[i] += 1
            return sizes
        by_pid = {}
        for c in cs:
            by_pid[c.get("pid")] = by_pid.get(c.get("pid"), 0) + 1
        return list(by_pid.values())
    calls_per_run = [n for r in tickets for n in run_sizes(r)]
    calls = [c for r in tickets for c in ticket_calls(r)]
    sizes = [len(prompt_corpus([c])) for c in calls]
    def system_prompts(cs):
        return {normalize(message_text(m))[:300] for c in cs for m in (c.get("messages") or [])[:1]
                if isinstance(m, dict) and m.get("role") == "system"}
    systems = system_prompts(calls)
    systems_per = [len(system_prompts(ticket_calls(r))) for r in tickets]
    all_imports = sorted({e["module"] for r in tickets for e in ticket_trace(r) if e.get("kind") == "import"})
    direct = {e["module"] for r in tickets for e in ticket_trace(r) if e.get("kind") == "import" and not e.get("by_library")}
    direct_imports = sorted(m for m in direct - GIVEN_LIBRARIES
                            if not (Path(bot_dir, m + ".py").exists() or Path(bot_dir, m).is_dir()))
    data_files = sorted({os.path.relpath(e["path"], bot_dir) for r in tickets for e in ticket_trace(r)
                         if e.get("kind") == "open" and not e["write"] and e["path"].startswith(bot_dir + "/")
                         and not e["path"].endswith(CODE_SUFFIXES) and os.path.basename(e["path"]) != "run"})
    written = sorted({e["path"] for r in tickets for e in ticket_trace(r)
                      if e.get("kind") == "open" and e["write"] and not e.get("by_library")})
    libs = sorted(set(all_imports) - baseline)
    handoffs = sum(1 for r in tickets for q in r.get("requests", []) if q["method"] == "POST" and q["path"].startswith("/handoffs"))
    programs = sorted({os.path.basename(e["program"]) for r in tickets for e in ticket_trace(r) if e.get("kind") == "exec"})
    embeddings = sum(1 for r in tickets for e in ticket_trace(r) if e.get("kind") == "embedding")
    processes = [sum(1 for e in ticket_trace(r) if e.get("kind") == "start") for r in tickets]
    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else 0
    return {
        "tickets": len(tickets),
        "model_calls_per_ticket": {"avg": avg(calls_per), "min": min(calls_per, default=0), "max": max(calls_per, default=0)},
        "model_calls_per_run": {"avg": avg(calls_per_run), "max": max(calls_per_run, default=0)},
        "models": sorted({str(c.get("model")) for c in calls}),
        "prompt_chars_per_call": {"avg": int(avg(sizes)), "max": max(sizes, default=0)},
        "distinct_system_prompts": len(systems),
        "max_system_prompts_in_one_ticket": max(systems_per, default=0),
        "tools_offered_to_model": sorted({t for c in calls for t in c.get("tools") or [] if t}),
        # False when no runtime trace came back (e.g. sandbox runs graded before traces were kept):
        # the trace-based fields below are then unknown, not zero.
        "traced": any(ticket_trace(r) for r in tickets),
        "embeddings_in_code": embeddings_in_code(bot_dir),
        "embedding_calls": embeddings,
        "bot_data_files_read": data_files,
        "files_written": written,
        "extra_libraries": libs,
        "all_imports": all_imports,
        "direct_imports": direct_imports,
        "handoffs_made": handoffs,
        "programs_started": programs,
        "python_processes_per_ticket": avg(processes),
        "changes_not_from_model": sum(c["source"] != "model" for r in tickets for c in r.get("change_sources") or []),
        "change_split": source_split(source_summary(tickets)),
    }


# ---------- bot code snapshot ----------

SNAPSHOT_SKIP = {"__pycache__", ".venv", "venv", "node_modules", ".git", ".cache"}
SNAPSHOT_MAX_BYTES = 2_000_000


def snapshot_bot(bot_dir, dest):
    """Copy the builder's bot (code and small files) into the logs; return [(relative path, lines or size)]."""
    bot_dir, dest = Path(bot_dir), Path(dest)
    shutil.rmtree(dest, ignore_errors=True)
    listing = []
    for root, dirs, files in os.walk(bot_dir):
        dirs[:] = sorted(d for d in dirs if d not in SNAPSHOT_SKIP)
        for name in sorted(files):
            src = Path(root) / name
            rel = src.relative_to(bot_dir)
            size = src.stat().st_size
            if size > SNAPSHOT_MAX_BYTES or name.endswith(".pyc"):
                listing.append((str(rel), f"{size // 1024} KB, not copied"))
                continue
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest / rel)
            try:
                n = len(src.read_text().splitlines())
                listing.append((str(rel), f"{n} line{'' if n == 1 else 's'}"))
            except (UnicodeDecodeError, OSError):
                listing.append((str(rel), f"{size // 1024} KB"))
    return listing


# ---------- builder's self-report (ARCHITECTURE.json) vs what was observed ----------

GIVEN_LIBRARIES = {"litellm", "requests", "numpy", "rank_bm25", "sitecustomize"}
CLAIM_KEYS = ["max_model_calls_per_ticket", "tools", "prompt_files", "skills", "extra_libraries",
              "human_handoff", "writes_files_at_runtime"]
STATED_TEXT = ["architecture_choice", "how_it_works", "parts", "how_docs_reach_the_model", "memory"]
MISSING = object()


def claim_value(report, key):
    value = report
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def file_reached_model(bot_dir, rel, prompts):
    """Is the file inside the bot folder, and did its text (any line of 30+ characters without template braces) reach the model?"""
    path = (Path(bot_dir) / str(rel)).resolve()
    if not str(path).startswith(str(Path(bot_dir).resolve()) + os.sep) or not path.is_file():
        return "file not found"
    try:
        text = path.read_text()
    except (OSError, UnicodeDecodeError):
        return "file not readable"
    lines = [normalize(l) for l in text.splitlines()]
    probes = [l for l in lines if len(l) >= 30 and "{" not in l] or [normalize(text)]
    return "" if any(p and p in prompts for p in probes) else "text never reached the model"


def import_names(lib):
    """Import names for a package name as the builder wrote it (e.g. scikit-learn -> {sklearn}), from installed metadata."""
    import importlib.metadata as md
    name = re.split(r"[=<>\[ ]", str(lib).strip(), maxsplit=1)[0]
    wanted = re.sub(r"[-_.]+", "-", name).lower()
    modules = {m for m, dists in md.packages_distributions().items()
               if any(re.sub(r"[-_.]+", "-", d).lower() == wanted for d in dists)}
    return modules | {name.replace("-", "_").lower(), name.replace("-", "_")}


def show_list(values):
    return ", ".join(str(v) for v in values) if values else "none"


def stated_text(report):
    """The builder's own description. Saved for the report and not graded."""
    out = {}
    for key in STATED_TEXT:
        value = claim_value(report, key)
        out[key] = value.strip() if isinstance(value, str) else ""
    return out


def check_self_report(report, card, bot_dir="/app/bot", prompts="", handoff_needed=True):
    """Compare the checkable claims in ARCHITECTURE.json with the trace.
    The written description and architecture_choice are returned in design and are not graded."""
    empty = {key: "" for key in STATED_TEXT}
    if not isinstance(report, dict):
        return {"given": False, "error": report if isinstance(report, str) else "no ARCHITECTURE.json",
                "claims": [], "right": 0, "checked": len(CLAIM_KEYS), "design": empty}
    imports = set(card.get("all_imports", []))
    libs = claim_value(report, "extra_libraries")
    stated = set()
    for lib in libs if isinstance(libs, list) else []:
        if isinstance(lib, str) and lib.strip():
            stated |= import_names(lib)
    unstated = [m for m in card.get("direct_imports", []) if m not in stated]
    rows = []

    def add(key, said, saw, ok):
        rows.append({"claim": key, "said": said, "saw": saw, "ok": ok})

    def files_claim(key, v):
        said = [str(x) for x in v] if isinstance(v, list) else []
        problems = [f"{x}: {p}" for x in said if (p := file_reached_model(bot_dir, x, prompts))]
        add(key, show_list(said), "; ".join(problems) or ("all reached the model" if said else "nothing to check"), not problems)

    traced = card.get("traced", True)
    for key in CLAIM_KEYS:
        if not traced and key in ("extra_libraries", "writes_files_at_runtime"):
            continue  # needs the runtime trace, which this run does not have
        v = claim_value(report, key)
        if v is MISSING or v is None:
            add(key, "not stated", "", False)
            continue
        if key == "max_model_calls_per_ticket":
            # The limit is the loop's, and the loop runs once per customer message: compare it with one bot run.
            per_run = card.get("model_calls_per_run")
            saw = per_run["max"] if per_run else card["model_calls_per_ticket"]["max"]
            add(key, v, f"up to {saw} model calls in one bot run" if per_run else f"up to {saw} model calls in one ticket",
                isinstance(v, int) and saw <= v)
        elif key == "tools":
            names = [t.get("name") if isinstance(t, dict) else t for t in v] if isinstance(v, list) else []
            said = sorted({str(n).lower() for n in names})
            saw = sorted({t.lower() for t in card["tools_offered_to_model"]})
            add(key, show_list(said), show_list(saw), said == saw)
        elif key in ("prompt_files", "skills"):
            files_claim(key, v)
        elif key == "human_handoff":
            saw = card["handoffs_made"] > 0
            if v is True and not saw and not handoff_needed:
                # No ticket in this stage needed a handoff, so "can hand off" cannot be checked here.
                add(key, True, "0 handoffs made; no ticket needed one", True)
            else:
                add(key, bool(v), f"{card['handoffs_made']} handoffs made", isinstance(v, bool) and bool(v) == saw)
        elif key == "extra_libraries":
            said = [str(x) for x in v] if isinstance(v, list) else []
            missing = [x for x in said if not import_names(x) & imports]
            problems = ([f"never loaded: {show_list(missing)}"] if missing else []) + \
                       ([f"used but not stated: {show_list(unstated)}"] if unstated else [])
            add(key, show_list(said), "; ".join(problems) or "all used, nothing unstated", not problems)
        elif key == "writes_files_at_runtime":
            saw = bool(card["files_written"])
            add(key, bool(v), show_list(card["files_written"][:5]), isinstance(v, bool) and bool(v) == saw)
    text = stated_text(report)
    return {"given": True, "error": "", "claims": rows, "right": sum(r["ok"] for r in rows), "checked": len(rows),
            "summary": text["how_it_works"][:1500], "design": text}


def load_self_report(path):
    path = Path(path)
    if not path.exists():
        return "no ARCHITECTURE.json"
    try:
        value = json.loads(path.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return f"ARCHITECTURE.json is not valid JSON ({e})"
    return value if isinstance(value, dict) else "ARCHITECTURE.json is not a JSON object"


# ----- RQ2 knowledge acquisition vs runtime realization (quantitative) -----
ACQUISITION_BLAMES = frozenset({
    "not kept", "not retrieved", "retrieval", "no tools",
})
RUNTIME_BLAMES = frozenset({
    "misapplied rule", "rule buried", "chose trap doc", "trap doc",
    "stale copy", "code decided", "execution",
})
BOT_FAILURE_BLAMES = frozenset({"crashed", "context overflow", "model call failed", "no model call"})
HARNESS_BLAMES = frozenset({"our limit", "our service", "customer fault"})
BLAME_BUCKETS = (("acquisition", ACQUISITION_BLAMES), ("runtime", RUNTIME_BLAMES),
                 ("bot_failure", BOT_FAILURE_BLAMES), ("harness", HARNESS_BLAMES))


def replay_class(r):
    """What a replay (the rule stated plainly in the ticket) says about one failed ticket.
    Passed and the rule had not reached the model: the bot lacked the knowledge (acquisition).
    Passed although the rule (or a trap doc) had reached the model: fixed when told (runtime).
    Failed even with the rule given: it cannot apply the rule (runtime)."""
    labels = {b.get("blame") for b in r.get("blame") or [] if isinstance(b, dict)}
    if not r["replay"].get("passed"):
        return "runtime_realization_failure", "cannot apply"
    # Over the prompt cap the model call was refused, so the rule never reached the model either.
    if labels & (ACQUISITION_BLAMES | {"context overflow"}):
        return "knowledge_acquisition_failure", "lacked the rule"
    return "runtime_realization_failure", "fixed when told"


def knowledge_application_summary(results, subset=None):
    """Explicit-context replay separates acquisition vs runtime realization failures."""
    def _count_map(items):
        out = {}
        for x in items:
            if not x:
                continue
            out[x] = out.get(x, 0) + 1
        return out

    failed = [r for r in results if isinstance(r, dict) and not r.get("passed")]
    replayed = [r for r in failed if isinstance(r.get("replay"), dict)]
    replay_passed = [r for r in replayed if r["replay"].get("passed")]
    replay_failed = [r for r in replayed if not r["replay"].get("passed")]

    blame_labels, sides = [], []
    for r in failed:
        for b in r.get("blame") or []:
            if not isinstance(b, dict):
                continue
            blame_labels.append(b.get("blame") or "?")
            sides.append(b.get("side") or "?")
    by_blame, by_side = _count_map(blame_labels), _count_map(sides)
    # Figure 1 buckets: one record per failed check, over every blame record.
    buckets = {name: sum(by_blame.get(k, 0) for k in labels) for name, labels in BLAME_BUCKETS}
    blame_total = sum(by_blame.values())
    n_rep, n_rp, n_rf = len(replayed), len(replay_passed), len(replay_failed)
    classes = [replay_class(r) for r in replayed]
    n_acq = sum(c == "knowledge_acquisition_failure" for c, _ in classes)
    out = {
        "failed": len(failed),
        "replayed": n_rep,
        "replay_passed": n_rp,
        "replay_failed": n_rf,
        "Qapplication": (n_rp / n_rep) if n_rep else None,
        "frac_knowledge_acquisition_failure": (n_acq / n_rep) if n_rep else None,
        "frac_runtime_realization_failure": ((n_rep - n_acq) / n_rep) if n_rep else None,
        "replay_reasons": _count_map(reason for _, reason in classes),
        "by_blame": by_blame,
        "by_side": by_side,
        "blame_records": blame_total,
        "blame_acquisition": buckets["acquisition"],
        "blame_runtime": buckets["runtime"],
        "blame_bot_failure": buckets["bot_failure"],
        "blame_harness": buckets["harness"],
        "frac_blame_acquisition": (buckets["acquisition"] / blame_total) if blame_total else None,
        "frac_blame_runtime": (buckets["runtime"] / blame_total) if blame_total else None,
        "frac_blame_bot_failure": (buckets["bot_failure"] / blame_total) if blame_total else None,
        "frac_blame_harness": (buckets["harness"] / blame_total) if blame_total else None,
        "tickets": [
            {
                "id": r.get("id"),
                "replay_passed": bool(r["replay"].get("passed")),
                "rules": r["replay"].get("rules") or [],
                "class": cls,
                "reason": reason,
                "blame": sorted({
                    b.get("blame") for b in (r.get("blame") or [])
                    if isinstance(b, dict) and b.get("blame")
                }),
            }
            for r, (cls, reason) in zip(replayed, classes)
        ],
    }
    if subset and isinstance(subset, dict):
        rules = int(subset.get("rules") or 0)
        kept = int(subset.get("kept") or 0)
        reached = int(subset.get("reached") or 0)
        out["subset"] = {
            "rules": rules, "kept": kept, "reached": reached,
            "kept_rate": (kept / rules) if rules else None,
            "reached_rate": (reached / rules) if rules else None,
        }
    return out

