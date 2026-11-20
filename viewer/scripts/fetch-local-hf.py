"""Download the two commit-pinned HF datasets from datasets/production.json into .local-data/{benchmark,runs} (resumable)."""
import json
from huggingface_hub import snapshot_download

release = json.load(open("datasets/production.json"))
for side in ("benchmark", "runs"):
    ref = release[side]
    snapshot_download(ref["repository"], repo_type="dataset", revision=ref["revision"], local_dir=f".local-data/{side}")
open(".local-data/.done", "w").close()  # marks a complete download
