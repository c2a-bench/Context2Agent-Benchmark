"""The failure names of fact-graded runs (research_notes/failure-nomenclature.md): party > group > type.

Nothing else defines these names. fact_metrics.py gives every failed check of a failed ticket one record with
taxonomy {party, group, type} from here; fact_run.py copies the records and counts them; the viewer shows the names
as they are. A group is its plain name with the matching metric in parentheses.

Blame order for one failed check: harness (when every record of the ticket is ours) -> builder (a fact deciding the
check is missing, the prompt went over the cap, or the
agent never started on any ticket of the stage) -> missing customer info -> the check's own symptom (agent).
"""

BUILDER, AGENT, HARNESS = "Builder", "Agent", "Harness"

# (party, group name, metric or None, [(blame id, type, decided when)]). The blame id is the record's "blame" label.
TABLE = [
    (BUILDER, "Missing knowledge", "rule recall", [
        ("fact absent", "Fact missing from the agent's files",
         "A fact deciding the failed check is absent from the agent's files"),
    ]),
    (BUILDER, "Build spec failure", None, [
        ("context overflow", "Prompt over the size cap",
         "The call was refused: prompt over the ticket's token cap (the ticket is graded as failed, not skipped)"),
        ("build broken", "Agent never started",
         "The agent's run program never got to a model call on any ticket of the stage: it is missing, or fails "
         "on start (a syntax error)"),
    ]),
    (AGENT, "Wrong end state", "database check", [
        ("wrong value", "Wrong value", "A field has the wrong value (also the catch-all for unknown check kinds)"),
        ("missing value", "Value not set", "A required field is empty"),
        ("missing label", "Missing label", "A required label is absent"),
        ("extra label", "Extra label", "A label the docs don't give this ticket"),
        ("forbidden action", "Forbidden action taken", "A forbidden call was made, or a call repeated past its limit"),
        ("missing required action", "Required action skipped", "A required call was not made"),
        ("protected state changed", "Protected record changed", "A record that must stay untouched was modified"),
    ]),
    # Reply checks (regex rules on what the agent told the customer): none in the published runs; kept so they are
    # named if one fails, not counted as a wrong value.
    (AGENT, "Wrong reply", "reply check", [
        ("wrong assertion", "Told the customer something wrong", "A reply check found a wrong or prohibited statement"),
        ("missing assertion", "Didn't tell the customer something required", "A reply check found a required statement missing"),
    ]),
    (AGENT, "Missing customer info", "customer recall", [
        ("missed customer fact", "Key fact never obtained from the customer",
         "A decisive customer fact for the check was never told, no needed fact missing"),
    ]),
    # The agent never answered (its own crash or model call): none in the published runs.
    (AGENT, "Agent crash", None, [
        ("crashed", "Agent crashed", "The agent crashed or broke the output contract"),
        ("model call failed", "Model call failed", "A model call failed before the agent finished the ticket"),
        ("no model call", "Never called the model", "The agent never asked the model"),
    ]),
    (HARNESS, "Our side", None, [
        ("our limit", "Time limit", "Our time limit or a stalled machine stopped the run"),
        ("runner crashed", "Runner crash", "Our verifier crashed"),
        ("our service", "Model provider down", "The language-model provider failed"),
        ("customer fault", "Customer simulator failed", "The simulated customer's model failed"),
        ("trace lost", "Trace lost", "The grader could not see the agent's model calls"),
    ]),
]

TYPES = {}  # blame id -> {"party", "group", "type"}
for _party, _name, _metric, _rows in TABLE:
    for _id, _type, _ in _rows:
        TYPES[_id] = {"party": _party, "group": f"{_name} ({_metric})" if _metric else _name, "type": _type}

HARNESS_IDS = {i for i, t in TYPES.items() if t["party"] == HARNESS}
CRASH_IDS = {"crashed", "model call failed", "no model call"}
REPLY_IDS = {"wrong assertion", "missing assertion"}


def symptom(check):
    """The blame id of what a failed end-state check showed (its kind in results.json "checks")."""
    kind = (check or {}).get("kind")
    if kind == "expect":
        return "missing value" if check.get("got") in (None, "None") else "wrong value"
    if kind == "missing":
        return "missing value" if check.get("key") == "attempt_id" else "missing label"
    if kind == "prohibited":
        return "extra label" if str(check.get("key", "")).startswith("labels:") else "wrong value"
    return {"extra": "extra label", "forbidden": "forbidden action", "repeated": "forbidden action",
            "required": "missing required action", "changed": "protected state changed"}.get(kind, "wrong value")


def harness_id(record):
    """The blame id of one of our own failures (the verifier's crash is filed as "our limit" on check "verifier")."""
    if record.get("blame") == "our limit" and record.get("check") == "verifier":
        return "runner crashed"
    return record.get("blame")


def record(blame_id, check, rules, side, detail):
    """One failed check's blame record."""
    return {"check": check, "rules": rules, "blame": blame_id, "side": side, "detail": detail,
            "taxonomy": dict(TYPES[blame_id])}


def counts(records):
    """Records per type, summed to group and party: the scores.json failure_taxonomy."""
    by_type, by_group, by_party = {}, {}, {}
    for b in records:
        tx = b.get("taxonomy") or TYPES["wrong value"]
        row = by_type.setdefault(tx["type"], {"party": tx["party"], "group": tx["group"], "count": 0})
        row["count"] += 1
        by_group[f"{tx['party']} / {tx['group']}"] = by_group.get(f"{tx['party']} / {tx['group']}", 0) + 1
        by_party[tx["party"]] = by_party.get(tx["party"], 0) + 1
    return {"records": sum(by_party.values()), "by_party": by_party, "by_group": by_group, "by_type": by_type}
