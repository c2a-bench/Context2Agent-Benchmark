#!/usr/bin/env python3
"""Publish a validated benchmark/runs pair, pin benchmark provenance, then verify anonymously.
Requires pre-existing public, ungated repos. Does not deploy Pages or create a repository.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

VIEWER = Path(__file__).resolve().parents[1]


def command(*args, public=False):
    env = dict(os.environ)
    if public:
        for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "BLOB_READ_WRITE_TOKEN"):
            env.pop(key, None)
    subprocess.run(["npm", "run", *args], cwd=VIEWER, env=env, check=True)


def publish(args):
    root = Path(args.dir).resolve()
    destination = Path(args.manifest).resolve()
    if destination.exists():
        raise ValueError("Candidate already exists; choose a new --manifest path")
    release_file = root / "release.json"
    release = json.loads(release_file.read_text())
    if release.get("schemaVersion") != 2 or release.get("provider") != "huggingface":
        raise ValueError("Expected a converted two-repository release")
    names = [release[side]["repository"] for side in ("benchmark", "runs")]
    if len(set(names)) != 2 or any(not re.fullmatch(r"[\w-]+/[\w.-]+", name) for name in names):
        raise ValueError("Configure two distinct dataset repositories")
    from huggingface_hub import HfApi, RepoFile, CommitOperationDelete, get_token
    token = os.environ.get("HF_TOKEN") or get_token()
    if not token:
        raise ValueError("HF_TOKEN with write access to both datasets is required; no upload attempted")
    api, anonymous = HfApi(token=token), HfApi(token=False)
    for side in ("benchmark", "runs"):
        info = api.repo_info(release[side]["repository"], repo_type="dataset")
        if info.private or getattr(info, "gated", False):
            raise ValueError("Both repos must already exist and be public/ungated")
        card = getattr(info, "card_data", None)
        card = card.to_dict() if hasattr(card, "to_dict") else card or {}
        local_card = (root / side / "README.md").read_text()
        local_license = re.search(r"^license:\s*(\S+)", local_card, re.MULTILINE)
        if card.get("license") and (not local_license or local_license.group(1) != card["license"]):
            raise ValueError("Existing HF license differs from the generated card; review explicitly before upload")
    command("verify:migration", "--", "--dir", str(root), public=True)

    def upload(side):
        reference = release[side]
        repo = reference["repository"]
        inventory = json.loads((root / side / "inventory.json").read_text())
        expected = {entry["path"] for entry in inventory["files"]} | {"inventory.json"}
        remote = {entry.path for entry in api.list_repo_tree(repo, recursive=True, repo_type="dataset") if isinstance(entry, RepoFile)}
        extras = remote - expected - {".gitattributes"}
        if extras:
            managed = tuple(f"{domain}/" for domain in release["domains"]) + ("data/", "content/")
            if not args.replace_managed or any(not name.startswith(managed) for name in extras):
                raise ValueError(f"Remote has unexpected files: {sorted(extras)[:8]}. Review before using --replace-managed.")
            ordered = sorted(extras)
            for i in range(0, len(ordered), 500):
                api.create_commit(repo_id=repo, repo_type="dataset", revision="main", operations=[CommitOperationDelete(path_in_repo=name) for name in ordered[i:i + 500]], commit_message="Remove retired managed release files")
        api.upload_large_folder(repo_id=repo, repo_type="dataset", revision="main", folder_path=root / side, ignore_patterns=[".cache", ".cache/**", "**/.cache/**", "**/*.part"], num_workers=args.workers)
        revision = api.repo_info(repo, repo_type="dataset").sha
        if not re.fullmatch(r"[a-f0-9]{40}", revision or ""):
            raise ValueError("Hub did not return a full immutable commit SHA")
        info = anonymous.repo_info(repo, revision=revision, repo_type="dataset")
        if info.private or getattr(info, "gated", False):
            raise ValueError("Pinned data is not public/ungated")
        actual = {entry.path for entry in anonymous.list_repo_tree(repo, recursive=True, revision=revision, repo_type="dataset") if isinstance(entry, RepoFile)}
        if actual - {".gitattributes"} != expected:
            raise ValueError("Uploaded file set differs from the local inventory")
        return revision

    benchmark_revision = upload("benchmark")
    benchmark_manifest = root / "benchmark-upload.json"
    benchmark_manifest.write_text(json.dumps({**release, "benchmark": {**release["benchmark"], "revision": benchmark_revision}}, indent=2) + "\n")
    command("verify:hf", "--", "--manifest", str(benchmark_manifest), "--side", "benchmark", public=True)
    # Only a publicly verified benchmark SHA can be pinned into run.json / generated JSONL.
    command("pin:release", "--", "--dir", str(root), "--benchmark-revision", benchmark_revision)
    release = json.loads(release_file.read_text())
    runs_revision = upload("runs")
    command("pin:release", "--", "--dir", str(root), "--benchmark-revision", benchmark_revision, "--runs-revision", runs_revision)
    command("verify:migration", "--", "--dir", str(root), "--report", str(root / "verification-report.json"), public=True)
    command("verify:hf", "--", "--manifest", str(release_file), "--report", str(root / "remote-verification.json"), public=True)
    # Only a completely verified pair becomes a selectable frontend release.
    with destination.open("x") as output:
        output.write(release_file.read_text())
    print(f"Verified two-repository candidate: {destination}. Review before promoting/deploying Pages.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True)
    parser.add_argument("--manifest", default="datasets/candidate.json")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--replace-managed", action="store_true", help="Explicitly allow removal of retired files in managed data/domain prefixes; never deletes unknown top-level files")
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        parser.error("--workers must be 1–32")
    try:
        publish(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
