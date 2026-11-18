#!/bin/bash
# Harbor runs this as root, in the same container, before the stage2 builder.
# Earlier stages already updated /app/docs. This applies this stage's doc
# changes and removes the staging files so the builder only sees /app/docs.
# The earlier bot stays at /app/bot.
set -euo pipefail

python3 - <<'PY'
import json
import shutil
import sys
from pathlib import Path

docs = Path("/app/docs")
staging = Path("/app/stage2_update")

changes = json.loads((staging / "changes.json").read_text())
for change in changes["changes"]:
    for patch in change.get("patches", []):
        path = docs / patch["doc"].removeprefix("docs/")
        text = path.read_text()
        if patch["find"] not in text:
            sys.exit(f"{change['id']}: {patch['find']!r} not found in {patch['doc']}")
        path.write_text(text.replace(patch["find"], patch["replace"]))
    if change.get("add_dir"):
        shutil.copytree(staging / change["add_dir"], docs, dirs_exist_ok=True)
shutil.rmtree(staging)
Path("/app/setup.sh").unlink(missing_ok=True)
PY
