#!/usr/bin/env python3
"""Copy a run as <job>-facts, graded the new way, so the viewer shows it as its own run.

    python3 scripts/fact_run.py tasks/<task>/jobs/<job>

Needs scripts/fact_metrics.py to have run on the job. The copy hard-links every file of the run (no extra disk),
then writes each step's results.json and scores.json as new files (the run's own files are never changed):
  - a failed ticket's blame records are fact_metrics.py's (one per failed check, named by
    scripts/failure_types.py);
  - the replays, the keyword-based "rules kept / reached" and doc recall are dropped;
  - failure_taxonomy and the blame counts are rebuilt from the new records.
Pass/fail, scores and everything else are the run's own.
"""
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import failure_types as ft  # noqa: E402

REPLAY_KEYS = ("full_replay", "replay", "plain_replay", "replay_verdict", "replays_skipped", "full_replay_lost",
               "plain_replay_lost", "replay_lost", "full_replay_lost_cost", "plain_replay_lost_cost")
DROP_SCORES = ("subset", "docs", "replay_verdicts", "behavior_attribution")
# The fact-level verdicts take the replay verdicts' place (results.json replay_verdict, scores.json replay_verdicts).
def load(path):
    return json.loads(Path(path).read_text())


def write_new(path, data):
    """Replace a hard-linked file with a new one, so the original run keeps its own copy."""
    path = Path(path)
    if path.exists():
        path.unlink()
    path.write_text(json.dumps(data, indent=1) + "\n")


def taxonomy(results):
    return ft.counts([b for r in results for b in r.get("blame") or []])


def blame_counts(results, ka):
    labels, sides = {}, {}
    for r in results:
        if r.get("passed"):
            continue
        for b in r.get("blame") or []:
            labels[b.get("blame")] = labels.get(b.get("blame"), 0) + 1
            sides[b.get("side")] = sides.get(b.get("side"), 0) + 1
    party = taxonomy(results)["by_party"]
    total = sum(labels.values())
    ka = dict(ka or {})
    ka.update({
        "replayed": 0, "replay_passed": 0, "replay_failed": 0, "Qapplication": None,
        "frac_knowledge_acquisition_failure": None, "frac_runtime_realization_failure": None, "replay_reasons": {},
        "tickets": [], "by_blame": labels, "by_side": sides, "blame_records": total,
        "blame_acquisition": party.get(ft.BUILDER, 0), "blame_runtime": party.get(ft.AGENT, 0), "blame_bot_failure": 0,
        "blame_harness": party.get(ft.HARNESS, 0),
    })
    for k in ("acquisition", "runtime", "bot_failure", "harness"):
        ka[f"frac_blame_{k}"] = (ka[f"blame_{k}"] / total) if total else None
    ka.pop("subset", None)
    return ka


def fact_verdict(t):
    """One verdict per failed ticket, in place of the replay verdict."""
    if t["blame"] == "builder":
        if any(c.get("never_started") for c in t["checks"]):
            return "agent never started"
        if any(c.get("crashed") for c in t["checks"]):
            return "prompt over cap"
        return "fact absent"
    if t["blame"] == "agent":
        # Only a missed decisive fact that decides a failed check counts (fact_tags.json "decides").
        return "missed customer fact" if any(c.get("missed_customer_facts") for c in t["checks"]) else "had the facts"
    return None


def ticket_rows(metrics, dummy_rule):
    """Per ticket, as the doc-recall table had it: needed facts right / absent, and the trap or stale facts the
    agent holds for the ticket's own rules."""
    held = [f for f, x in metrics["per_fact"].items() if x["kind"] in ("trap", "stale") and x["label"] == "right"]
    rows = []
    for tid, t in metrics["tickets"].items():
        if t["rule_recall"] is None:
            continue
        rules = {f.split(".")[0] for f in t["rule_facts"]}
        rows.append({"id": tid, "passed": t["passed"], "recall": t["rule_recall"], "precision": t.get("rule_precision"),
                     "right": [f for f, l in t["rule_facts"].items() if l == "right"],
                     "absent": [f for f, l in t["rule_facts"].items() if l == "absent"],
                     "traps": [f for f in held if dummy_rule.get(f) in rules]})
    return rows


def facts_block(metrics, results, judge, customer, dummy_rule=None):
    """The step's fact-level numbers for the viewer (scores.json "facts")."""
    behavior = {r["id"]: r.get("behavior") for r in results}
    by_behavior = {}
    for tid, t in metrics["tickets"].items():
        row = by_behavior.setdefault(behavior.get(tid) or "none", {"tickets": 0, "decisive": 0, "obtained": 0,
                                                                     "failed": 0, "failed_missed": 0,
                                                                     "questions": 0, "relevant": 0})
        row["tickets"] += 1
        decisive = [c for c in t["customer_facts"] if c.get("decisive")]
        row["decisive"] += len(decisive)
        row["obtained"] += sum(c.get("told", False) for c in decisive)
        # The agent's information-seeking turns, and those asking for a decisive fact (customer precision).
        wanted = {c["text"] for c in decisive}
        row["questions"] += len(t.get("questions", []))
        row["relevant"] += sum(any(f in wanted for f in q["asks_for"]) for q in t.get("questions", []))
        if not t["passed"] and t["blame"] != "harness":
            row["failed"] += 1
            row["failed_missed"] += any(c.get("missed_customer_facts") for c in t["checks"])
    tickets = [t for t in metrics["tickets"].values() if t["rule_recall"] is not None]
    cost = ((judge.get("usage") or {}).get("cost") or 0) + sum(u.get("cost") or 0 for u in customer.get("usage") or [])
    return {
        "judge_model": judge.get("model"), "facts_model": customer.get("model"), "cost": round(cost, 4),
        "rule_recall": metrics["rule_recall"], "rule_precision": metrics["rule_precision"],
        "rule_recall_per_ticket": metrics.get("rule_recall_per_ticket"),
        "rule_precision_per_ticket": metrics.get("rule_precision_per_ticket"),
        "customer_recall": metrics["customer_recall"], "customer_precision": metrics["customer_precision"],
        "kinds": metrics["facts"],
        "tickets": len(tickets), "full_recall": sum(t["rule_recall"] == 1 for t in tickets),
        "failed_full_recall": sum(t["rule_recall"] == 1 and not t["passed"] for t in tickets),
        "failed_missing": sum(t["rule_recall"] < 1 and not t["passed"] for t in tickets),
        "passed_missing": sum(t["rule_recall"] < 1 and t["passed"] for t in tickets),
        "dummies_held": sum(x["label"] == "right" for x in metrics["per_fact"].values() if x["kind"] in ("trap", "stale")),
        "rows": (rows := ticket_rows(metrics, dummy_rule or {})),
        "trap_tickets": sum(bool(r["traps"]) for r in rows),
        "kept": (lambda u: sum(x["label"] == "right" for x in u) / len(u) if u else None)(
            [x for x in metrics["per_fact"].values() if x["kind"] == "rule"]),
        "by_behavior": by_behavior,
    }


def judge_cost(cost, judge_usd):
    """The run's cost without replays (they are not run), with the judge and the customer-facts reader."""
    cost = dict(cost or {})
    for k in ("replay_bot", "replay_customer"):
        cost.pop(k, None)
    cost["judge"] = {"usd": judge_usd}
    cost["usd"] = round(sum((cost.get(k) or {}).get("usd") or 0 for k in ("bot", "customer", "sandbox", "judge")), 6)
    return cost


def facts_of(step):
    tests = Path(__file__).resolve().parents[1] / "tasks" / step.parents[1].name.split("__")[0] / "tests"
    for own in (tests / "stages" / step.name / "facts.json", tests / "packs" / step.name / "facts.json"):
        if own.exists():
            return load(own)["facts"]
    return load(tests / "facts.json")["facts"]


def main(job):
    job = Path(job).resolve()
    trial = next(p for p in job.iterdir() if (p / "steps").is_dir())
    old = [s.name for s in sorted((trial / "steps").iterdir()) if (s / "verifier/fact-metrics/metrics.json").exists()
           and any("records" not in t for t in load(s / "verifier/fact-metrics/metrics.json")["tickets"].values())]
    if old:
        sys.exit(f"metrics.json of {', '.join(old)} has no blame records (saved before failure_types.py): run "
                 f"scripts/fact_metrics.py {job} first (it reuses the saved judge answers, no model calls)")
    out = job.with_name(job.name + "-facts")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(job, out, copy_function=os.link)
    trial = next(p for p in out.iterdir() if (p / "steps").is_dir())
    for step in sorted((trial / "steps").iterdir()):
        v = step / "verifier"
        if not (v / "fact-metrics" / "metrics.json").exists():
            continue
        fm = v / "fact-metrics"
        metrics = load(fm / "metrics.json")
        tickets = metrics["tickets"]
        texts = {f: x.get("text", "") for f, x in metrics["per_fact"].items()}
        texts.update({f["id"]: f["text"] for f in facts_of(step)})
        quotes = {f: x.get("quote", "") for f, x in metrics["per_fact"].items()}
        results = load(v / "results.json")
        verdicts = {}
        for r in results:
            for k in REPLAY_KEYS:
                r.pop(k, None)
            t = tickets.get(r["id"])
            if not t:
                continue
            # What the ticket view shows: the facts it needs, as the judge found them, and the customer facts.
            r["facts"] = {
                "rule_facts": [{"id": f, "label": lab, "text": texts.get(f, ""), "quote": quotes.get(f, "")}
                               for f, lab in t["rule_facts"].items()],
                "customer_facts": t["customer_facts"], "rule_recall": t["rule_recall"],
                "rule_precision": t.get("rule_precision"), "wrong_versions_held": t.get("wrong_versions_held", []),
                "questions": t.get("questions", []), "customer_precision": t.get("customer_precision"),
                "customer_recall": t["customer_recall"], "blame": t["blame"],
            }
            if not r.get("passed"):
                r["blame"] = t["records"]
                verdict = fact_verdict(t)
                if verdict:
                    r["replay_verdict"] = verdict
                    verdicts[verdict] = verdicts.get(verdict, 0) + 1
        write_new(v / "results.json", results)
        scores = load(v / "scores.json")
        for k in DROP_SCORES:
            scores.pop(k, None)
        scores["failure_taxonomy"] = taxonomy([r for r in results if not r.get("passed")])
        ka = blame_counts(results, scores.get("knowledge_application"))
        useful = [x for x in metrics["per_fact"].values() if x["kind"] == "rule"]
        right = sum(x["label"] == "right" for x in useful)
        ka["subset"] = {"rules": len(useful), "kept": right, "kept_rate": right / len(useful) if useful else None,
                        "reached": None, "reached_rate": None}
        scores["knowledge_application"] = ka
        scores["replay_verdicts"] = verdicts
        dummy_rule = {f["id"]: f.get("rule") for f in facts_of(step) if f["kind"] in ("trap", "stale")}
        scores["facts"] = facts_block(metrics, results, load(fm / "judge.json"), load(fm / "customer.json"), dummy_rule)
        scores["cost"] = judge_cost(scores.get("cost"), scores["facts"]["cost"])
        write_new(v / "scores.json", scores)
        for f in ("docs_recall.json",):
            if (v / f).exists():
                (v / f).unlink()
        print(f"{step.name}: {scores['failure_taxonomy']['by_party']}")
    print(f"-> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
