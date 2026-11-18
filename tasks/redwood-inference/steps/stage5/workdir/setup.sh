#!/bin/bash
# Harbor runs this as root, in the same container, before the stage5 builder.
# Earlier stages already updated /app/docs. This applies this stage's doc
# and API changes and removes the staging files so the builder only sees
# /app/docs, /app/api_docs, and /app/examples. The earlier bot stays at /app/bot.
set -euo pipefail

python3 - <<'PY'
import json
import shutil
import sys
from pathlib import Path

docs = Path("/app/docs")
staging = Path("/app/stage5_update")

changes = json.loads((staging / "changes.json").read_text())
for change in changes["changes"]:
    for patch in change.get("patches", []):
        rel = patch["doc"]
        if rel.startswith("api_docs/"):
            path = Path("/app") / rel
        else:
            path = docs / rel.removeprefix("docs/")
        text = path.read_text()
        if patch["find"] not in text:
            sys.exit(f"{change['id']}: {patch['find']!r} not found in {patch['doc']}")
        path.write_text(text.replace(patch["find"], patch["replace"]))
    if change.get("add_dir"):
        shutil.copytree(staging / change["add_dir"], docs, dirs_exist_ok=True)

extra = staging / "new_examples"
if extra.exists():
    cases_path = Path("/app/examples/cases.json")
    cases = json.loads(cases_path.read_text())
    ids = {c["id"] for c in cases}
    for case in json.loads((extra / "cases.json").read_text()):
        if case["id"] not in ids:
            cases.append(case)
    cases_path.write_text(json.dumps(cases, indent=2) + "\n")
    for name in ("tickets", "api_keys", "customers"):
        src = extra / "seed" / f"{name}.json"
        if not src.exists():
            continue
        dest = Path(f"/app/examples/seed/{name}.json")
        data = json.loads(dest.read_text()) if dest.exists() else {}
        data.update(json.loads(src.read_text()))
        dest.write_text(json.dumps(data, indent=2) + "\n")

shutil.rmtree(staging)
Path("/app/setup.sh").unlink(missing_ok=True)
PY
