"""Grade the stage 1 fixtures. No model, no Harbor run.

python3 tasks/redwood-inference/steps/stage1/check/check.py
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TASK = HERE.parents[2]
UPDATE = TASK / "steps/stage1/workdir/stage1_update"
CASES = TASK / "tests/stages/stage1/cases.json"
RULES = TASK / "tests/stages/stage1/rules.json"
TESTS = TASK / "tests"


def load(path):
    return json.loads(Path(path).read_text())


def apply_changes(docs_dir):
    for change in load(UPDATE / "changes.json")["changes"]:
        for patch in change.get("patches", []):
            path = docs_dir / patch["doc"].removeprefix("docs/")
            text = path.read_text()
            if patch["find"] not in text:
                sys.exit(f"{change['id']}: {patch['find']!r} not found in {patch['doc']}")
            path.write_text(text.replace(patch["find"], patch["replace"]))
        if change.get("add_dir"):
            shutil.copytree(UPDATE / change["add_dir"], docs_dir, dirs_exist_ok=True)


def main():
    cases = load(CASES)
    case_ids = {c["id"] for c in cases}
    changed = {c["id"] for c in cases if c.get("change_type", "none") != "none"}
    blame = [f for f in load(TESTS / "blame_fixtures.json") if f["case"] in case_ids and f["case"] not in changed]
    blame += load(HERE / "blame_fixtures.json")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        app = root / "app"
        shutil.copytree(TASK / "environment/app", app)
        apply_changes(app / "docs")
        fixtures = root / "fixtures"
        shutil.copytree(TESTS / "fixtures", fixtures)
        for f in fixtures.glob("*.json"):
            if f.stem not in case_ids:
                f.unlink()
        for f in (HERE / "fixtures").glob("*.json"):
            shutil.copyfile(f, fixtures / f.name)
        blame_path = root / "blame_fixtures.json"
        blame_path.write_text(json.dumps(blame, indent=2) + "\n")
        result = subprocess.run([
            sys.executable, str(TESTS / "verify.py"), "check",
            "--cases", str(CASES),
            "--seed", str(TESTS / "seed"),
            "--fixtures", str(fixtures),
            "--rules", str(RULES),
            "--app", str(app),
            "--blame-fixtures", str(blame_path),
        ])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
