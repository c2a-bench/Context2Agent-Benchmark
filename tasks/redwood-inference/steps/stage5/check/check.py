"""Grade the stage5 fixtures. No model, no Harbor run.

python3 tasks/redwood-inference/steps/stage5/check/check.py
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TASK = HERE.parents[2]
STAGE = "stage5"
PRIOR = ["stage1", "stage2", "stage3", "stage4", "stage5"]
UPDATES = [
    TASK / "steps/stage1/workdir/stage1_update",
    TASK / "steps/stage2/workdir/stage2_update",
    TASK / "steps/stage3/workdir/stage3_update",
    TASK / "steps/stage4/workdir/stage4_update",
    TASK / "steps/stage5/workdir/stage5_update",
]
CASES = TASK / "tests/stages/stage5/cases.json"
RULES = TASK / "tests/stages/stage5/rules.json"
TESTS = TASK / "tests"


def load(path):
    return json.loads(Path(path).read_text())


def apply_changes(app):
    docs_dir = app / "docs"
    for update in UPDATES:
        for change in load(update / "changes.json")["changes"]:
            for patch in change.get("patches", []):
                rel = patch["doc"]
                if rel.startswith("api_docs/"):
                    path = app / rel
                else:
                    path = docs_dir / rel.removeprefix("docs/")
                text = path.read_text()
                if patch["find"] not in text:
                    sys.exit(f"{change['id']}: {patch['find']!r} not found in {patch['doc']}")
                path.write_text(text.replace(patch["find"], patch["replace"]))
            if change.get("add_dir"):
                shutil.copytree(update / change["add_dir"], docs_dir, dirs_exist_ok=True)


def main():
    cases = load(CASES)
    case_ids = {c["id"] for c in cases}
    changed = {c["id"] for c in cases if c.get("change_type", "none") != "none"}
    blame = [f for f in load(TESTS / "blame_fixtures.json") if f["case"] in case_ids and f["case"] not in changed]
    extra = HERE / "blame_fixtures.json"
    if extra.exists():
        blame += load(extra)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        app = root / "app"
        shutil.copytree(TASK / "environment" / "app", app)
        apply_changes(app)
        fixtures = root / "fixtures"
        shutil.copytree(TESTS / "fixtures", fixtures)
        for name in PRIOR:
            src = TASK / f"steps/{name}/check/fixtures"
            if src.exists():
                for f in src.glob("*.json"):
                    if f.stem in case_ids:
                        shutil.copyfile(f, fixtures / f.name)
        for f in fixtures.glob("*.json"):
            if f.stem not in case_ids:
                f.unlink()
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
