#!/usr/bin/env python3
"""Download the C2A bench from Hugging Face and fill the task folders with it, ready to run.

    python3 scripts/fetch_bench.py --revision <commit>            # observeai/c2a-bench at that commit
    python3 scripts/fetch_bench.py --local <bench folder>          # a bench already on disk

The code is in this repo (tasks/<domain>/: task.toml, environment Dockerfile and server, setup.sh, grader); the data
is in observeai/c2a-bench. This writes, for redwood-inference, support-agent-knowledge and skyway-air:

  what the builder gets      environment/app/docs (each doc's file), environment/app/api_docs, environment/app/examples,
                             instruction.md and steps/<stage>/instruction.md, each stage's update folder
                             (steps/<stage>/workdir/<stage>_update: new and edited docs, removed docs, new practice
                             tickets), each knowledge pack (steps/<pack>/workdir/pack/docs), Skyway's architectures/
  what the grader reads      tests/cases.json, rules.json, facts.json, fact_tags.json, seed/, and per stage
                             tests/stages/<stage>/{cases,rules,facts}.json (Skyway: and seed/), tests/packs/<pack>/unknown.json

The bench stores each thing once (docs as their fields, rules and facts as what each stage adds or changes, practice
tickets once); <domain>/format.json says how each file is written, so every file comes back byte for byte.
"""
import argparse
import json
import re
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOMAINS = ["redwood-inference", "support-agent-knowledge", "skyway-air"]
PASS_KEYS = ("expect", "contains", "not_contains", "unchanged", "required_calls", "forbidden_calls", "must_not")
TAG_KEYS = ("group", "behavior", "info_type", "twin", "change_type", "prompt_cap_tokens")


def pass_dict(p):
    """A ticket's pass checks as the grader has them. The bench lists them: {check, field, value, list, json}."""
    if isinstance(p, dict):
        return p
    out = {}
    for c in p or []:
        vals = [json.loads(v) for v in c["value"]] if c.get("json") else list(c["value"])
        val = vals if c.get("list") else vals[0]
        if c.get("field") is None:
            out[c["check"]] = val
        else:
            out.setdefault(c["check"], {})[c["field"]] = val
    return out


def derive_case(t):
    """The grader's ticket fields that follow from a published ticket (the rest is in its `grading` field)."""
    d = {"id": t["id"], "title": t.get("title", ""), "test": t.get("test", ""), "matters": t.get("matters", ""),
         "rules": [r["id"] for r in t.get("rules", [])],
         "input": {"ticket_id": t["ticket"], "customer_id": t["customer"]["id"], "message": t.get("opening", "")},
         "customer": t.get("brief", ""), "facts": [f["text"] for f in t.get("facts", [])]}
    d.update({k: v for k, v in pass_dict(t.get("pass")).items() if k in PASS_KEYS})
    d.update({k: v for k, v in (t.get("tags") or {}).items() if k in TAG_KEYS and v is not None})
    return d


def derive_practice(t):
    """A practice ticket's fields that follow from its row in train.json."""
    d = {"id": t["id"], "test": t.get("test", ""),
         "input": {"ticket_id": t["ticket"], "customer_id": t["customer"]["id"], "message": t.get("opening", "")}}
    d.update({k: v for k, v in pass_dict(t.get("pass")).items() if k in PASS_KEYS})
    return d


def rebuild(t, derive):
    """A ticket back in its original form, field for field: what follows from its columns, then its `grading`."""
    g = t.get("grading") or {}
    g = json.loads(g) if isinstance(g, str) else g
    d = derive(t)
    for k in g.get("absent", []):
        d.pop(k, None)
    for k in g.get("input_absent", []):
        d["input"].pop(k, None)
    d.update(g.get("fields", {}))
    d["input"].update(g.get("input_fields", {}))
    d["input"] = {k: d["input"][k] for k in g.get("input_order", d["input"])}
    return {k: d[k] for k in g.get("order", d)}


def grader_case(t):
    """A graded ticket in the grader's own format (tests/cases.json)."""
    return rebuild(t, derive_case)


def practice_case(t):
    """A practice ticket as the builder gets it (examples/cases.json)."""
    return rebuild(t, derive_practice)


def dump(obj, indent):
    return json.dumps(obj, indent=indent, ensure_ascii=True) + "\n"


_INLINE = re.compile(r'\[\n(?:\s*(?:"(?:[^"\\]|\\.)*"|-?[\d.eE+-]+|true|false|null),?\n)+\s*\]')


def dumps(obj, f):
    """A JSON file as written: indent, ASCII escaping or not, short lists on one line or not, final newline or not."""
    s = json.dumps(obj, indent=f["indent"], ensure_ascii=f["ascii"])
    if f.get("inline"):
        s = _INLINE.sub(lambda m: json.dumps(json.loads(m.group(0)), ensure_ascii=f["ascii"]), s)
    return s + ("\n" if f["newline"] else "")


class Bench:
    def __init__(self, local=None, repo="observeai/c2a-bench", revision=None):
        self.local, self.repo, self.revision = Path(local) if local else None, repo, revision

    def path(self, rel):
        if self.local:
            return self.local / rel
        from huggingface_hub import hf_hub_download
        return Path(hf_hub_download(self.repo, rel, repo_type="dataset", revision=self.revision))

    def json(self, rel, default=None):
        try:
            return json.loads(self.path(rel).read_text())
        except (FileNotFoundError, OSError):
            return default
        except Exception as e:  # missing on the Hub
            if type(e).__name__ in ("EntryNotFoundError", "RemoteEntryNotFoundError"):
                return default
            raise


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def fill(bench, domain, task):
    meta = bench.json(f"{domain}/task.json")
    fmt = bench.json(f"{domain}/format.json")
    stages = meta["stages"]
    idx = [s["index"] for s in stages]
    packs = stages[0].get("docs_mode") == "snapshot"
    app = task / "environment" / "app"
    license_text = (app / "docs" / "UPSTREAM_LICENSE").read_text() if (app / "docs" / "UPSTREAM_LICENSE").exists() else None
    cache = {}

    def get(rel, default=None):
        if rel not in cache:
            cache[rel] = bench.json(rel, default)
        return cache[rel]

    def doc_files(n):
        """A stage's docs as their files: path -> text."""
        own = fmt["docs"].get(str(n), {})
        return {path: e["text"] if "file" not in e else dumps(e["file"], own.get(path, fmt["doc_default"]))
                for path, e in get(f"{domain}/stages/{n}/docs.json", {}).items()}

    def tests_of(n):
        st = stages[idx.index(n)]
        return get(f"{domain}/stages/{st.get('tests_from', n)}/test.json", [])

    practice = {t["id"]: t for t in get(f"{domain}/train.json", [])}
    seed_rows = {}
    for table in {t for ex in fmt["examples"].values() for t in ex["seed"]}:
        for r in get(f"{domain}/train_seed/{table}.json", []):
            seed_rows[(table, r["stage"], r["id"])] = {k: v for k, v in r.items() if k not in ("id", "stage")}

    def examples(n):
        """A stage's new practice tickets and their records, as the builder gets them."""
        ex = fmt["examples"][str(n)]
        cases = [practice_case(practice[i]) for i in ex["cases"]]
        seed = {t: {i: seed_rows[(t, n, i)] for i in ids} for t, ids in ex["seed"].items()}
        return ex, cases, seed

    # stage 0 (or the first pack): the starting docs, API reference, examples
    for d in ("docs", "api_docs", "examples"):
        shutil.rmtree(app / d, ignore_errors=True)
    for rel, text in doc_files(idx[0]).items():
        write(app / rel, text)
    if license_text is not None:
        write(app / "docs" / "UPSTREAM_LICENSE", license_text)
    ex, cases, seed = examples(idx[0])
    for rel, f in ex["files"].items():
        obj = cases if rel == "examples/cases.json" else seed[rel[len("examples/seed/"):-len(".json")]]
        write(app / rel, f["text"] if "text" in f else dumps(obj, f))

    # instructions: a stage without its own instruction.json uses the previous one
    instr = None
    for i, st in enumerate(stages):
        n, label = st["index"], st["label"]
        got = bench.json(f"{domain}/stages/{n}/instruction.json")
        instr = got["text"] if got else instr
        write(task / "steps" / label / "instruction.md", instr)
        if i == 0 and domain != "skyway-air":
            write(task / "instruction.md", instr)

    if packs:  # each pack is a full doc set the step installs
        for st in stages:
            n, label = st["index"], st["label"]
            pack = task / "steps" / label / "workdir" / "pack"
            shutil.rmtree(pack / "docs", ignore_errors=True)
            for rel, text in doc_files(n).items():
                if rel.startswith("docs/"):
                    write(pack / rel, text)
            if license_text is not None:
                write(pack / "docs" / "UPSTREAM_LICENSE", license_text)
    else:  # each later stage: its new and edited docs in full, its removed docs, its new practice tickets
        for st in stages[1:]:
            n, label = st["index"], st["label"]
            up = task / "steps" / label / "workdir" / f"{label}_update"
            shutil.rmtree(up, ignore_errors=True)
            changes = bench.json(f"{domain}/stages/{n}/changes.json", {})
            for rel, text in doc_files(n).items():
                if rel.startswith("docs/"):
                    write(up / "new_docs" / rel[len("docs/"):], text)
            # the API reference is not under docs/: its edits stay find/replace patches setup.sh applies
            api = [{"id": c["id"], "type": c.get("type"), "what": c.get("what", ""),
                    "patches": [p for p in c.get("patches", []) if p["doc"].startswith("api_docs/")]}
                   for c in changes.get("changes", []) if any(p["doc"].startswith("api_docs/") for p in c.get("patches", []))]
            spec = {"changes": [{"id": f"{label}-docs", "type": "docs", "what": "This stage's new and edited docs, in full.",
                                 "patches": [], "add_dir": "new_docs"}] + api}
            if changes.get("deleted"):
                spec["remove_docs"] = changes["deleted"]
            write(up / "changes.json", dump(spec, 2))
            if str(n) in fmt["examples"]:
                _, cases, seed = examples(n)
                write(up / "new_examples" / "cases.json", dump(cases, 2))
                for name, rows in seed.items():
                    write(up / "new_examples" / "seed" / f"{name}.json", dump(rows, 2))

    arch = bench.json(f"{domain}/architectures.json")
    if arch:
        for name, text in arch.items():
            write(task / "architectures" / f"{name}.md", text)

    # the grader's own files
    def parts(n, name):
        """Stage n's rules.json / facts.json is what stages up to n add or change (a later one replaces by id)."""
        return [p for p in (get(f"{domain}/stages/{m}/{name}") for m in idx[: idx.index(n) + 1]) if p is not None]

    tests = task / "tests"
    for rel, spec in fmt["tests"].items():
        kind = spec["kind"]
        if kind == "cases":
            tickets = {t["id"]: t for t in tests_of(spec["stage"])}
            write(tests / rel, dump([grader_case(tickets[i]) for i in spec["order"]], spec["indent"]))
        elif kind == "seed":
            rows = [] if spec.get("empty") else get(f"{domain}/seed/{spec['table']}.json", [])
            recs = {r["id"]: {k: v for k, v in r.items() if k not in ("id", "stage")}
                    for r in rows if r.get("stage") == spec.get("stage")}
            write(tests / rel, dump({k: recs[k] for k in spec["order"]}, spec["indent"]))
        elif kind == "rules":
            by = {}
            for part in parts(spec["stage"], "rules.json"):
                by.update({r["id"]: r for r in part})
            write(tests / rel, dumps([by[i] for i in spec["order"]], spec["format"]))
        elif kind == "facts":
            facts, tickets = {}, {}
            for part in parts(spec["stage"], "facts.json"):
                facts.update({f["id"]: f for f in part["facts"]})
                tickets.update(part["tickets"])
            obj = {"_about": spec["about"], "step": spec["step"], "facts": [facts[i] for i in spec["facts"]],
                   "tickets": {k: tickets[k] for k in spec["tickets"]}}
            write(tests / rel, dumps(obj, spec["format"]))
        elif kind == "fact_tags":  # the customer facts that decide a ticket, from the tickets' facts
            by_label = {s["label"]: s["index"] for s in stages}
            obj = {"_about": spec["about"]}
            for tid, labels in spec["tickets"].items():
                obj[tid] = {}
                for lab in labels:
                    n = by_label[lab] if lab in by_label else int(lab[len("stage"):])
                    t = next(x for x in tests_of(n) if x["id"] == tid)
                    got = {f["text"]: {k: v for k, v in f.items() if k != "text"} for f in t["facts"]}
                    order = spec.get("fact_order", {}).get(tid, {}).get(lab, list(got))
                    obj[tid][lab] = {k: got[k] for k in order}
            write(tests / rel, dumps(obj, spec["format"]))
        elif kind == "verbatim":
            write(tests / rel, bench.path(f"{domain}/stages/{spec['stage']}/{spec['file']}").read_text())
        else:
            raise SystemExit(f"{domain}: unknown file kind {kind} for {rel}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--revision", help="observeai/c2a-bench commit to download")
    ap.add_argument("--local", help="use a bench folder on disk instead")
    ap.add_argument("--repo", default="observeai/c2a-bench")
    ap.add_argument("--tasks", default=str(REPO / "tasks"))
    ap.add_argument("--only", nargs="*", default=DOMAINS)
    a = ap.parse_args()
    if not a.local and not a.revision:
        ap.error("give --revision <commit> (or --local <folder>)")
    bench = Bench(a.local, a.repo, a.revision)
    for domain in a.only:
        fill(bench, domain, Path(a.tasks) / domain)
        print(f"{domain}: filled {Path(a.tasks) / domain}")


if __name__ == "__main__":
    main()
