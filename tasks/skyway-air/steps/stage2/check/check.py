"""Grade the stage 2 fixtures and blame fixtures. No model, no Harbor run.

python3 tasks/skyway-air/steps/stage2/check/check.py

With environment/app/docs in place, also checks every rule's evidence against the docs as they are at stage 2
(stages 1-2 applied with their setup.sh, in order).
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

N = 2
HERE = Path(__file__).resolve().parent
TASK = HERE.parents[2]
STAGE = TASK / f"tests/stages/stage{N}"
TESTS = TASK / "tests"


def load(path):
    return json.loads(Path(path).read_text())


def main():
    cases = load(STAGE / "cases.json")
    case_ids = {c["id"] for c in cases}
    changed = {c["id"] for c in cases if c.get("change_type", "none") != "none"}
    blame = [f for f in load(TESTS / "blame_fixtures.json") if f["case"] in case_ids and f["case"] not in changed]
    blame += load(HERE / "blame_fixtures.json")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        blame_path = root / "blame_fixtures.json"
        blame_path.write_text(json.dumps(blame, indent=2) + "\n")
        app_args = []
        if (TASK / "environment/app/docs").is_dir():
            app = root / "app"
            shutil.copytree(TASK / "environment/app", app)
            for k in range(1, N + 1):
                shutil.copytree(TASK / f"steps/stage{k}/workdir/stage{k}_update", app / f"stage{k}_update")
                subprocess.run(["bash", str(TASK / f"steps/stage{k}/workdir/setup.sh"), str(app)], check=True)
            app_args = ["--app", str(app)]
        else:
            print("environment/app/docs is not there yet: rule evidence is not checked against the docs")
        result = subprocess.run([
            sys.executable, str(TESTS / "verify.py"), "check",
            "--cases", str(STAGE / "cases.json"),
            "--seed", str(STAGE / "seed"),
            "--fixtures", str(STAGE / "fixtures"),
            "--rules", str(STAGE / "rules.json"),
            "--blame-fixtures", str(blame_path),
            *app_args,
        ])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
