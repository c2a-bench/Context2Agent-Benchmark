#!/usr/bin/env python3
"""Check a submission before opening the PR.

    python3 scripts/validate_submission.py submissions/<name>/submission.json [--runs-root DIR]

Run paths in submission.json are relative to --runs-root (default: the repo root). Checks the fields, the pinned
benchmark revision, that every run is a judged `-facts` folder with a scores.json per stage, and that each task is
complete (Skyway: all six architectures, the knowledge packs: all five).
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ["organization", "contact", "builder_model", "harness", "reasoning_effort", "benchmark_revision", "standard", "runs", "runs_url"]
NEEDED = {"skyway-air": 6, "support-agent-knowledge": 5, "redwood-inference": 1}  # runs per task


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("submission")
    ap.add_argument("--runs-root", default=str(ROOT))
    a = ap.parse_args()
    errors: list[str] = []
    try:
        s = json.loads(Path(a.submission).read_text())
    except (OSError, ValueError) as e:
        print(f"cannot read {a.submission}: {e}")
        return 1
    for k in REQUIRED:
        if s.get(k) in (None, "", []):
            errors.append(f"missing field: {k}")
    pinned = json.loads((ROOT / "viewer/datasets/production.json").read_text())["benchmark"]["revision"]
    if s.get("benchmark_revision") != pinned:
        errors.append(f"benchmark_revision is {s.get('benchmark_revision')}, the pinned one is {pinned}")
    if not re.fullmatch(r"[\w.-]+@[\w.-]+\.\w+", str(s.get("contact", ""))):
        errors.append("contact must be an email address")

    per_task: dict[str, int] = {}
    for run in s.get("runs", []):
        path = Path(a.runs_root) / run
        task = next((t for t in NEEDED if f"/{t}/" in f"/{run}/"), None)
        if not run.rstrip("/").endswith("-facts"):
            errors.append(f"{run}: submit the judged -facts folder")
        if task is None:
            errors.append(f"{run}: not under a known task ({', '.join(NEEDED)})")
        else:
            per_task[task] = per_task.get(task, 0) + 1
        if not path.is_dir():
            errors.append(f"{run}: no such folder under {a.runs_root}")
            continue
        stages = len(list((ROOT / "tasks" / task / "steps").glob("*"))) if task and (ROOT / "tasks" / task / "steps").is_dir() else 0
        have = len(list(path.glob("steps/*/**/scores.json")))
        if stages and have < stages:
            errors.append(f"{run}: scores.json for {have} of {stages} stages (a stage is missing or was not judged)")
    for task, n in per_task.items():
        if n < NEEDED[task]:
            errors.append(f"{task}: {n} runs, needs {NEEDED[task]}")

    for e in errors:
        print("x", e)
    print(f"{'FAILED' if errors else 'OK'}: {len(s.get('runs', []))} runs, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
