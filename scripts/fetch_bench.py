#!/usr/bin/env python3
"""Download the C2A bench from Hugging Face and fill the task folders with it, ready to run.

    python3 scripts/fetch_bench.py --revision <commit>            # observeai/c2a-bench at that commit
    python3 scripts/fetch_bench.py --local <bench folder>          # a bench already on disk

The code is in this repo (tasks/<domain>/: task.toml, environment Dockerfile and server, setup.sh, grader); the data
is in observeai/c2a-bench. This writes, for redwood-inference, support-agent-knowledge and skyway-air:

  what the builder gets      environment/app/docs (each doc's raw file), environment/app/api_docs, environment/app/examples,
                             instruction.md and steps/<stage>/instruction.md, each stage's update folder
                             (steps/<stage>/workdir/<stage>_update: new and edited docs, removed docs, new practice
                             tickets), each knowledge pack (steps/<pack>/workdir/pack/docs), Skyway's architectures/
  what the grader reads      tests/cases.json, rules.json, facts.json, fact_tags.json, seed/, and per stage
                             tests/stages/<stage>/{cases,rules,facts}.json (Skyway: and seed/), tests/packs/<pack>/unknown.json

Every stage's update folder gives the builder exactly the docs it had in that stage: setup.sh copies the stage's new
and edited docs in (their full text) and removes the stage's removed docs.
"""
import argparse
import json
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOMAINS = ["redwood-inference", "support-agent-knowledge", "skyway-air"]
PASS_KEYS = ("expect", "contains", "not_contains", "unchanged", "required_calls", "forbidden_calls", "must_not")
TAG_KEYS = ("group", "behavior", "info_type", "twin", "change_type", "prompt_cap_tokens")


def pass_dict(p):
    """A ticket's pass checks as the grader has them. The bench lists them ({check, field, value, list, json});
    older benches kept the grader's own form."""
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
         "customer": t.get("brief", "")}
    d.update({k: v for k, v in pass_dict(t.get("pass")).items() if k in PASS_KEYS})
    d.update({k: v for k, v in (t.get("tags") or {}).items() if k in TAG_KEYS and v is not None})
    return d


def grader_case(t):
    """A published ticket back in the grader's own format (tests/cases.json), field for field."""
    g = t.get("grading") or {}
    d = derive_case(t)
    for k in g.get("absent", []):
        d.pop(k, None)
    for k in g.get("input_absent", []):
        d["input"].pop(k, None)
    d.update(g.get("fields", {}))
    d["input"].update(g.get("input_fields", {}))
    d["input"] = {k: d["input"][k] for k in g.get("input_order", d["input"])}
    return {k: d[k] for k in g.get("order", d)}


def dump(obj, indent):
    return json.dumps(obj, indent=indent, ensure_ascii=True) + "\n"


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
    fmt = bench.json(f"{domain}/grader/format.json")
    stages = meta["stages"]
    packs = stages[0].get("docs_mode") == "snapshot"
    app = task / "environment" / "app"
    license_text = (app / "docs" / "UPSTREAM_LICENSE").read_text() if (app / "docs" / "UPSTREAM_LICENSE").exists() else None

    def raw_docs(n):
        return bench.json(f"{domain}/stages/{n}/raw.json", {})

    def put_doc(base, rel, text):  # rel is "docs/…" or "api_docs/…"
        write(base / rel, text)

    # stage 0 (or the first pack): the starting docs, API reference, examples
    first = raw_docs(stages[0]["index"])
    for d in ("docs", "api_docs", "examples"):
        shutil.rmtree(app / d, ignore_errors=True)
    for rel, text in first.items():
        put_doc(app, rel, text)
    if license_text is not None:
        write(app / "docs" / "UPSTREAM_LICENSE", license_text)
    if not any(rel.startswith("examples/") for rel in first):  # older bench: examples only as JSON
        ex0 = bench.json(f"{domain}/stages/{stages[0]['index']}/examples.json")
        write(app / "examples" / "cases.json", dump(ex0["cases"], 2))
        for name, rows in ex0["seed"].items():
            write(app / "examples" / "seed" / f"{name}.json", dump(rows, 2))

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
            for rel, text in raw_docs(n).items():
                if rel.startswith("docs/"):
                    put_doc(pack, rel, text)
            if license_text is not None:
                write(pack / "docs" / "UPSTREAM_LICENSE", license_text)
    else:  # each later stage: its new and edited docs in full, its removed docs, its new practice tickets
        for st in stages[1:]:
            n, label = st["index"], st["label"]
            up = task / "steps" / label / "workdir" / f"{label}_update"
            shutil.rmtree(up, ignore_errors=True)
            delta = raw_docs(n)
            changes = bench.json(f"{domain}/stages/{n}/changes.json")
            for rel, text in delta.items():
                if rel.startswith("docs/"):
                    put_doc(up / "new_docs", rel[len("docs/"):], text)
            # the API reference is not under docs/: its edits stay find/replace patches setup.sh applies
            api = [{"id": c["id"], "type": c.get("type"), "what": c.get("what", ""),
                    "patches": [p for p in c.get("patches", []) if p["doc"].startswith("api_docs/")]}
                   for c in changes["changes"] if any(p["doc"].startswith("api_docs/") for p in c.get("patches", []))]
            spec = {"changes": [{"id": f"{label}-docs", "type": "docs", "what": "This stage's new and edited docs, in full.",
                                 "patches": [], "add_dir": "new_docs"}] + api}
            if changes.get("deleted"):
                spec["remove_docs"] = changes["deleted"]
            write(up / "changes.json", dump(spec, 2))
            ex = bench.json(f"{domain}/stages/{n}/examples.json")
            if ex and (ex.get("cases") or ex.get("seed")):
                write(up / "new_examples" / "cases.json", dump(ex["cases"], 2))
                for name, rows in ex["seed"].items():
                    write(up / "new_examples" / "seed" / f"{name}.json", dump(rows, 2))

    arch = bench.json(f"{domain}/architectures.json")
    if arch:
        for name, text in arch.items():
            write(task / "architectures" / f"{name}.md", text)

    # the grader's own files
    tests = task / "tests"
    for rel, spec in fmt["files"].items():
        if spec["kind"] == "verbatim":
            write(tests / rel, bench.path(f"{domain}/grader/{rel}").read_text())
        elif spec["kind"] == "cases":
            tickets = {t["id"]: t for t in bench.json(f"{domain}/stages/{spec['stage']}/cases.json")}
            write(tests / rel, dump([grader_case(tickets[i]) for i in spec["order"]], spec["indent"]))
        elif spec["kind"] == "seed":
            rows = bench.json(f"{domain}/seed/{spec['table']}.json")
            recs = {r["id"]: {k: v for k, v in r.items() if k not in ("id", "stage")}
                    for r in rows if r.get("stage") == spec.get("stage")}
            write(tests / rel, dump({k: recs[k] for k in spec["order"]}, spec["indent"]))


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
