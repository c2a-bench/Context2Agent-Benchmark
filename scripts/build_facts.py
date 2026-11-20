#!/usr/bin/env python3
"""Build the fact list each step's bot is judged against (fact-level metrics), and print the counts per step.

A fact is one rule from the step's rules.json, except the two table rules, which are split into one fact per cell
with a decisive value each: R1 (priority definitions) into R1.P0..R1.P4, and R2 (first response, tier x priority)
into R2.<priority>.<tier>. Only rules written as those tables are split ("P0 = ..." and "P2: self_serve 1bd, ...").
A task with tests/rule_parts.json (skyway-air, whose rules' parts sit in different docs) splits every rule the same
way, into one fact per part (an evidence sentence: R12.1, R12.2, ...), and a ticket is judged on the parts it needs.
The judge gets, per step:
  rule   the facts the step needs: the union of the facts of the step's tickets
  trap   a wrong version of a needed rule: a sentence from an old, draft or look-alike page (its trap_evidence)
  stale  an earlier version of a needed fact, or of a needed rule (its stale_evidence)
A fact no ticket of the step needs, and wrong versions of rules no ticket needs, are left out.
Per ticket: the facts its deciding rules give (rules listed on the ticket, R1/R2 narrowed to the ticket's cell),
the customer facts (cases.json "facts", decisive per tests/fact_tags.json), and its type against earlier steps:
  discovery     a ticket no earlier step had
  regression    an earlier step's ticket with the same pass conditions
  adaptability  an earlier step's ticket whose pass conditions changed
A label added after the step a ticket was last asked in (no ticket up to that step names it) that the re-asked ticket
must not set does not change its pass conditions: the builder adds each step's new labels to every ticket's
not_contains, but the answer is the same.

Writes tests/facts.json (stage 0, or every pack of a pack task) and tests/stages/<stage>/facts.json.

  python3 scripts/build_facts.py tasks/redwood-inference
  python3 scripts/build_facts.py tasks/support-agent-knowledge
  python3 scripts/build_facts.py tasks/skyway-air
"""

import json
import re
import sys
from pathlib import Path

TIERS = ["self_serve", "dedicated", "private", "enterprise"]
PRIORITIES = ["P0", "P1", "P2", "P3", "P4"]
# What a ticket must end with: two tickets with the same values here have the same pass conditions.
PASS_KEYS = ("expect", "contains", "not_contains", "unchanged", "forbidden_calls", "required_calls", "must_not")


def load(path):
    return json.loads(Path(path).read_text())


def split_priorities(text):
    """R1 -> {priority: definition}. Handles "P0 = ... P1 = ..." with or without parentheses or semicolons."""
    parts = re.split(r"\b(P[0-4]) = ", text)
    head, out = parts[0], {}
    for p, body in zip(parts[1::2], parts[2::2]):
        out[p] = body.strip().rstrip(").;").strip()
    return head.strip(), out


def split_table(text):
    """R2 -> {(priority, tier): (value, note)}. "P2: self_serve 1bd, dedicated/private 4h, others 2h." style."""
    cells = {}
    for p, body in re.findall(r"\b(P[0-4]): (.*?)(?=\s*\bP[0-4]:|$)", text):
        for item in re.split(r",\s*(?![^()]*\))", body.strip().rstrip(".")):
            m = re.match(r"([a-z_/]+) (\S+)(?: \((.*)\))?$", item.strip())
            if not m:
                raise SystemExit(f"R2: cannot read {item!r}")
            tiers, value, note = m.group(1), m.group(2), m.group(3) or ""
            for tier in (TIERS if tiers == "others" else tiers.split("/")):
                if (p, tier) not in cells:  # "others" fills only the tiers not named
                    cells[(p, tier)] = (value, note)
    for p in PRIORITIES:
        for tier in TIERS:
            if (p, tier) not in cells:
                raise SystemExit(f"R2: no value for {p} {tier}")
    return cells


def is_table(rule):
    """R1 written as priority definitions ("P0 = ..."), or R2 as the tier x priority table ("P2: self_serve 1bd")."""
    if rule["id"] == "R1":
        return re.search(r"\bP[0-4] = ", rule["rule"]) is not None
    return rule["id"] == "R2" and re.search(r"\bP[0-4]: [a-z_/]+ \S+", rule["rule"]) is not None


PARTS = None  # tests/rule_parts.json "steps": {step: {ticket: {"needed": [part, ...]}}}, when the task has it


def topic(rule):
    head = rule["rule"].split(":")[0]
    return head if len(head) <= 40 else " ".join(rule["rule"].split()[:6])


def rule_facts(rule):
    """The facts one rule gives: (id, text, value)."""
    rid, text = rule["id"], rule["rule"]
    if PARTS is not None and not is_table(rule):
        return [(f"{rid}.{k}", f"{rid} ({topic(rule)}): {e}", None) for k, e in enumerate(rule["evidence"], 1)]
    if not is_table(rule):
        return [(rid, text, None)]
    if rid == "R1":
        _, defs = split_priorities(text)
        return [(f"R1.{p}", f"Priority {p}: {d}", p) for p, d in defs.items()]
    if rid == "R2":
        return [(f"R2.{p}.{tier}", f"First response at {p} for tier {tier}: {value}"
                 + (f" ({note})" if note else ""), value)
                for (p, tier), (value, note) in split_table(text).items()]
    # The rule's own text carries its value: a ticket's checks also name labels that must not be set (an old name).
    return [(rid, text, None)]


def ticket_cell(case, seed_tickets, customers):
    tid = case["input"]["ticket_id"]
    priority = case["expect"].get(f"tickets.{tid}.priority") or seed_tickets[tid].get("priority")
    tier = customers[case["input"]["customer_id"]]["tier"]
    return priority, tier


def needed_facts(case, fact_ids, seed_tickets, customers, step=None, rules=None):
    if PARTS is not None:  # the parts the ticket needs (scripts/label_rule_parts.py)
        needed = set(PARTS.get(step, {}).get(case["id"], {}).get("needed", []))
        by_id = {r["id"]: r for r in rules}
        return [f"{rid}.{k}" for rid in case.get("rules", []) if rid in by_id
                for k, e in enumerate(by_id[rid]["evidence"], 1) if e in needed and f"{rid}.{k}" in fact_ids]
    # Each table rule is checked on its own: one may be split into cells while the other keeps its plain ID.
    r1_table = any(f.startswith("R1.") for f in fact_ids)
    r2_table = any(f.startswith("R2.") for f in fact_ids)
    priority, tier = ticket_cell(case, seed_tickets, customers) if r1_table or r2_table else (None, None)
    out = []
    for rid in case.get("rules", []):
        # A ticket with no priority to reach (none expected, none on the ticket) needs no cell of the tables.
        if rid == "R1" and r1_table:
            out += [f"R1.{priority}"] if f"R1.{priority}" in fact_ids else []
        elif rid == "R2" and r2_table:
            out += [f"R2.{priority}.{tier}"] if f"R2.{priority}.{tier}" in fact_ids else []
        elif rid in fact_ids:
            out.append(rid)
    return list(dict.fromkeys(out))


def stage_tags(by_stage, step):
    """A ticket's fact tags for this step: the latest entry at or before it (entries are per changed version)."""
    n = int(step[5:]) if step.startswith("stage") else 0
    keys = [k for k in by_stage if int(k[5:]) <= n]
    return by_stage[max(keys, key=lambda k: int(k[5:]))] if keys else {}


def strings_in(x, out):
    """Every string inside x (dict keys and values, list items)."""
    if isinstance(x, str):
        out.add(x)
    elif isinstance(x, dict):
        for k, v in x.items():
            out.add(k)
            strings_in(v, out)
    elif isinstance(x, list):
        for v in x:
            strings_in(v, out)
    return out


def same_pass_conditions(case, prev, known):
    """Whether case asks for what prev asked for. In not_contains, a value not in `known` (the strings the pass
    conditions named up to prev's step: a label added later goes into every ticket's must-not-set list) is left out."""
    for k in PASS_KEYS:
        a, b = case.get(k), prev.get(k)
        if k == "not_contains" and isinstance(a, dict) and isinstance(b, dict):
            a = {f: ([v for v in vs if v in known] if isinstance(vs, list) else vs) for f, vs in a.items()}
        if a != b:
            return False
    return True


def build_step(step_name, rules, cases, earlier_rules, earlier_cases, tags, seed_tickets, customers):
    facts, by_id = [], {}
    for rule in rules:
        for fid, text, value in rule_facts(rule):
            by_id[fid] = {"id": fid, "rule": rule["id"], "kind": "rule", "text": text, "value": value,
                          "sources": rule.get("sources", [])}
            facts.append(by_id[fid])
    # Dummies: trap sentences, stale sentences, and earlier versions of a fact that now reads differently.
    # A rule with an earlier version gets that version as its stale fact; its stale_evidence sentences say the same
    # thing again, so they count only for a rule with no earlier version here.
    dummies, has_old = {}, set()
    for old in (earlier_rules if PARTS is None else []):  # parts: an earlier version is a stale_evidence sentence
        for fid, text, value in rule_facts(old):
            if fid in by_id and by_id[fid]["text"] != text:
                has_old.add(old["id"])
                dummies.setdefault(("stale", text), {"rule": old["id"], "value": value, "sources": old.get("sources", []),
                                                     "replaces": fid})
    for rule in rules:
        for kind, key in (("trap", "trap_evidence"), ("stale", "stale_evidence")):
            if kind == "stale" and rule["id"] in has_old:
                continue
            for s in rule.get(key, []):
                if str(s).strip():
                    dummies.setdefault((kind, s.strip()), {"rule": rule["id"], "value": None, "sources": rule.get("decoys", [])})
    for n, ((kind, text), d) in enumerate(sorted(dummies.items(), key=lambda kv: (kv[1]["rule"], kv[0])), 1):
        facts.append({"id": f"{kind}-{n}", "kind": kind, "text": text, **d})

    fact_ids = [f["id"] for f in facts if f["kind"] == "rule"]
    tickets, used = {}, {}
    seen = {}
    for c in earlier_cases or []:
        seen[c["id"]] = c
    for case in cases:
        need = needed_facts(case, fact_ids, seed_tickets, customers, step_name, rules)
        for fid in need:
            used[fid] = used.get(fid, 0) + 1
        prev = seen.get(case["id"])
        kind = None if earlier_cases is None else (
            "discovery" if prev is None else
            "regression" if same_pass_conditions(case, prev, prev.get("_known", set())) else "adaptability")
        own = stage_tags(tags.get(case["id"], {}), step_name)
        tickets[case["id"]] = {
            "type": kind,
            "rule_facts": need,
            "customer_facts": [{"text": f, "decisive": (own.get(f) or {}).get("decisive"),
                                "why": (own.get(f) or {}).get("why"), "decides": (own.get(f) or {}).get("decides", [])}
                               for f in case.get("facts", [])],
        }
    # Only what the step needs, and the wrong versions of exactly that: an earlier version of a needed fact (a table
    # cell is its own fact), and a rule's trap or stale sentences when the step needs that rule.
    needed = set(used)
    needed_rules = {f["rule"] for f in facts if f["id"] in needed}
    kept = []
    for f in facts:
        if f["kind"] == "rule":
            if f["id"] in needed:
                kept.append({**f, "used_by": used[f["id"]]})
        elif f.get("replaces"):
            if f["replaces"] in needed:
                kept.append(f)
        elif f.get("rule") in needed_rules:
            kept.append(f)
    return {"facts": kept, "tickets": tickets}


def counts(step):
    kinds = {}
    for f in step["facts"]:
        kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
    cf = [x for t in step["tickets"].values() for x in t["customer_facts"]]
    types = {}
    for t in step["tickets"].values():
        if t["type"]:
            types[t["type"]] = types.get(t["type"], 0) + 1
    return {
        "tickets": len(step["tickets"]),
        "useful facts": kinds.get("rule", 0),
        "trap facts": kinds.get("trap", 0),
        "stale facts": kinds.get("stale", 0),
        "customer facts": len(cf),
        "decisive": sum(x["decisive"] is True for x in cf),
        "not decisive": sum(x["decisive"] is False for x in cf),
        "untagged": sum(x["decisive"] is None for x in cf),
        **types,
    }


def main(task):
    task = Path(task).resolve()
    tests = task / "tests"
    tags_file = tests / "fact_tags.json"
    if not tags_file.exists():
        # Without tags no customer fact is decisive, and customer recall and missed-fact blame stay empty.
        raise SystemExit(f"{tags_file} is missing: tag the customer facts (decisive, why, decides) first")
    tags = {k: v for k, v in load(tags_file).items() if not k.startswith("_")}
    seed_tickets, customers = load(tests / "seed/tickets.json"), load(tests / "seed/customers.json")
    global PARTS
    if (tests / "rule_parts.json").exists():
        PARTS = load(tests / "rule_parts.json")["steps"]
    about = ("Generated by scripts/build_facts.py from rules.json, cases.json and tests/fact_tags.json; "
             "do not edit by hand.")
    steps = [("stage0", tests)] + sorted(((p.name, p) for p in (tests / "stages").glob("stage*") if (p / "cases.json").exists()),
                                         key=lambda s: int(s[0][5:]))
    rows, earlier_rules, earlier_cases, known = [], [], [], set()
    for name, folder in steps:
        rules = load(folder / "rules.json") if (folder / "rules.json").exists() else load(tests / "rules.json")
        cases = load(folder / "cases.json")
        step = build_step(name, rules, cases, earlier_rules, earlier_cases if len(steps) > 1 else None, tags, seed_tickets, customers)
        (folder / "facts.json").write_text(json.dumps({"_about": about, "step": name, **step}, indent=1) + "\n")
        rows.append((name, counts(step)))
        earlier_rules = earlier_rules + rules
        for c in cases:  # what the pass conditions named up to this step, kept on each case for later steps
            for k in PASS_KEYS:
                strings_in(c.get(k), known)
        frozen = frozenset(known)
        earlier_cases = earlier_cases + [{**c, "_known": frozen} for c in cases]
    if len(steps) == 1 and (task / "steps").is_dir():
        rows = [(f"{rows[0][0]} (all {len(list((task / 'steps').iterdir()))} packs)", rows[0][1])]
    keys = list(dict.fromkeys(k for _, r in rows for k in r))
    print("| step | " + " | ".join(keys) + " |")
    print("| --- " * (len(keys) + 1) + "|")
    for name, r in rows:
        print(f"| {name} | " + " | ".join(str(r.get(k, 0)) for k in keys) + " |")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tasks/redwood-inference")
