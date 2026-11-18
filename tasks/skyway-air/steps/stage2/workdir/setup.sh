#!/bin/bash
# Harbor runs this as root, in the same container, before the stage2 builder.
# Earlier stages already updated /app/docs. This adds this stage's new docs,
# applies its doc and API patches, removes the docs it retires, adds its practice examples, and removes the staging files so the builder
# only sees /app/docs, /app/api_docs and /app/examples. The earlier bot stays at /app/bot.
set -euo pipefail

python3 - "${1:-/app}" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

DOC_TIME = 1779235200  # 2026-05-20 00:00 UTC, the same time the image gives the stage-0 docs
app = Path(sys.argv[1])
docs = app / "docs"
staging = app / "stage2_update"

if (staging / "new_docs").exists():
    shutil.copytree(staging / "new_docs", docs, dirs_exist_ok=True)
changes = json.loads((staging / "changes.json").read_text())
for change in changes["changes"]:
    for patch in change.get("patches", []):
        rel = patch["doc"]
        path = app / rel if rel.startswith("api_docs/") else docs / rel.removeprefix("docs/")
        text = path.read_text()
        if patch["find"] not in text:
            sys.exit(f"{change['id']}: {patch['find']!r} not found in {patch['doc']}")
        path.write_text(text.replace(patch["find"], patch["replace"]))
# docs this stage retires (ordinary pages archived, as a real docs space does)
for rel in changes.get("remove_docs", []):
    path = docs / rel.removeprefix("docs/")
    if not path.exists():
        sys.exit(f"remove_docs: {rel} not found")
    path.unlink()
# this stage's new practice examples (a ticket with a hidden runtime condition), with their practice data
extra = staging / "new_examples"
if extra.exists():
    examples = app / "examples"
    cases_path = examples / "cases.json"
    cases = json.loads(cases_path.read_text())
    ids = {c["id"] for c in cases}
    cases += [c for c in json.loads((extra / "cases.json").read_text()) if c["id"] not in ids]
    cases_path.write_text(json.dumps(cases, indent=2) + "\n")
    for src in sorted((extra / "seed").glob("*.json")):
        dest = examples / "seed" / src.name
        data = json.loads(dest.read_text()) if dest.exists() else {}
        data.update(json.loads(src.read_text()))
        dest.write_text(json.dumps(data, indent=2) + "\n")
# one file time for every doc, so new and edited docs do not stand out by their time
for f in list(docs.rglob("*")) + list((app / "api_docs").rglob("*")):
    os.utime(f, (DOC_TIME, DOC_TIME))
shutil.rmtree(staging)
(app / "setup.sh").unlink(missing_ok=True)
PY
