import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish_release", Path(__file__).with_name("publish-release.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublishReleaseTests(unittest.TestCase):
    def layout(self, root):
        release = {"schemaVersion": 2, "provider": "huggingface", "domains": ["redwood-inference"]}
        for side in ("benchmark", "runs"):
            folder = root / side
            folder.mkdir()
            (folder / "README.md").write_text("---\nlicense: bsd\n---\n")
            (folder / "inventory.json").write_text(json.dumps({"files": [{"path": "README.md"}]}))
            release[side] = {"repository": f"example/{side}", "revision": None, "path": "", "inventorySha256": "c" * 64}
        (root / "release.json").write_text(json.dumps(release))
        return release

    def test_publisher_requires_token_before_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.layout(root)
            sdk = types.SimpleNamespace(HfApi=lambda **kw: self.fail("No API calls without token"), RepoFile=object, CommitOperationDelete=object, get_token=lambda: None)
            args = argparse.Namespace(dir=str(root), manifest=str(root / "candidate.json"), workers=2, replace_managed=False)
            with patch.dict(os.environ, {}, clear=True), patch.dict("sys.modules", {"huggingface_hub": sdk}):
                with self.assertRaisesRegex(ValueError, "HF_TOKEN"):
                    module.publish(args)
            self.assertFalse((root / "candidate.json").exists())

    def test_two_repos_pin_before_runs_upload_and_candidate_only_after_public_verification(self):
        for failure in (False, True):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); self.layout(root); candidate = root / "candidate.json"
                calls = []; uploaded = set(); test = self

                class RepoFile:
                    def __init__(self, path): self.path = path

                class Api:
                    def __init__(self, token): calls.append(("api", token))
                    def repo_info(self, repo, **kwargs):
                        return types.SimpleNamespace(private=False, gated=False, sha=("a" if repo.endswith("benchmark") else "b") * 40, card_data={"license": "bsd"})
                    def list_repo_tree(self, repo, **kwargs):
                        return [RepoFile(".gitattributes"), RepoFile("README.md")] + ([RepoFile("inventory.json")] if repo in uploaded else [])
                    def upload_large_folder(self, **kwargs):
                        test.assertFalse(candidate.exists())
                        if kwargs["repo_id"].endswith("runs"):
                            state = json.loads((root / "release.json").read_text())
                            test.assertEqual(state["benchmark"]["revision"], "a" * 40)
                        uploaded.add(kwargs["repo_id"]); calls.append(("upload", kwargs["repo_id"]))

                def command(*args, public=False):
                    calls.append(("command", args, public))
                    test.assertFalse(candidate.exists())
                    if args[0] == "pin:release":
                        state = json.loads((root / "release.json").read_text())
                        state["benchmark"]["revision"] = args[args.index("--benchmark-revision") + 1]
                        if "--runs-revision" in args: state["runs"]["revision"] = args[args.index("--runs-revision") + 1]
                        (root / "release.json").write_text(json.dumps(state))
                    if failure and args[0] == "verify:hf" and "--side" not in args:
                        raise subprocess.CalledProcessError(1, "verify:hf")

                sdk = types.SimpleNamespace(HfApi=Api, RepoFile=RepoFile, CommitOperationDelete=object, get_token=lambda: None)
                args = argparse.Namespace(dir=str(root), manifest=str(candidate), workers=2, replace_managed=False)
                with patch.dict(os.environ, {"HF_TOKEN": "publisher-secret"}, clear=True), patch.dict("sys.modules", {"huggingface_hub": sdk}), patch.object(module, "command", side_effect=command):
                    if failure:
                        with self.assertRaises(subprocess.CalledProcessError): module.publish(args)
                        self.assertFalse(candidate.exists())
                    else:
                        module.publish(args)
                        selected = json.loads(candidate.read_text())
                        self.assertEqual(selected["benchmark"]["revision"], "a" * 40)
                        self.assertEqual(selected["runs"]["revision"], "b" * 40)
                        self.assertNotIn("publisher-secret", candidate.read_text())
                        self.assertIn(("api", False), calls)
                self.assertEqual([c[1] for c in calls if c[0] == "upload"], ["example/benchmark", "example/runs"])

    def test_anonymous_verifier_does_not_inherit_tokens(self):
        with patch.dict(os.environ, {"HF_TOKEN": "secret", "BLOB_READ_WRITE_TOKEN": "source-secret"}), patch.object(module.subprocess, "run") as run:
            module.command("verify:hf", public=True)
            self.assertNotIn("HF_TOKEN", run.call_args.kwargs["env"])
            self.assertNotIn("BLOB_READ_WRITE_TOKEN", run.call_args.kwargs["env"])


if __name__ == "__main__":
    unittest.main()
