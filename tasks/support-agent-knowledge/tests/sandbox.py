"""Run one verifier ticket (or follow-up pair) in a Daytona sandbox.

The stage verifier stays the Harbor orchestrator. Each ticket gets its own
4-CPU sandbox so we can fan out past local/orchestrator CPU limits.
"""

from __future__ import annotations

import json
import os
import shlex
import tarfile
import tempfile
import threading
import time
from pathlib import Path

PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]
PASS_ENV = PROVIDER_KEYS + [
    "BOT_MODEL",
    "EMBED_MODEL",
    "CUSTOMER_MODEL",
    "LITELLM_LOCAL_MODEL_COST_MAP",
]

# One shared declarative image build across tickets in this process.
_IMAGE_LOCK = threading.Lock()
_CACHED_IMAGE = None


def backend():
    """local = in-process threads; daytona = one sandbox per ticket/pair.

    Default is local. Set TICKET_SANDBOX=daytona explicitly to fan out.
    """
    mode = (os.environ.get("TICKET_SANDBOX") or "local").strip().lower()
    if mode == "daytona":
        return "daytona"
    return "local"


def _env_vars():
    env = {"LITELLM_LOCAL_MODEL_COST_MAP": "True"}
    for key in PASS_ENV:
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def _resources():
    from daytona import Resources

    cpu = int(os.environ.get("TICKET_SANDBOX_CPU", "4"))
    memory = int(os.environ.get("TICKET_SANDBOX_MEMORY_GIB", "4"))
    disk = int(os.environ.get("TICKET_SANDBOX_DISK_GIB", "10"))
    return Resources(cpu=cpu, memory=memory, disk=disk)


def _worker_image():
    """Declarative image matching tests/Dockerfile (python + litellm + bot user)."""
    global _CACHED_IMAGE
    with _IMAGE_LOCK:
        if _CACHED_IMAGE is not None:
            return _CACHED_IMAGE
        from daytona import Image

        override = (os.environ.get("TICKET_SANDBOX_IMAGE") or "").strip()
        if override:
            _CACHED_IMAGE = override
            return _CACHED_IMAGE
        _CACHED_IMAGE = (
            Image.debian_slim("3.12")
            .pip_install("litellm==1.103.2", "requests==2.34.2", "numpy==2.2.6", "rank-bm25==0.2.2")
            .run_commands(
                "useradd --create-home --shell /bin/bash bot || true",
                "mkdir -p /tests /app /srv/data /logs/verifier /tmp/job",
            )
            .env({"LITELLM_LOCAL_MODEL_COST_MAP": "True"})
            .workdir("/tests")
        )
        return _CACHED_IMAGE


def _tar_tree(src: Path, arcname: str) -> Path:
    """Write a gzipped tar of src to a temp file; caller must delete it."""
    tmp = tempfile.NamedTemporaryFile(prefix="ticket-", suffix=".tar.gz", delete=False)
    tmp.close()
    with tarfile.open(tmp.name, "w:gz") as tar:
        tar.add(src, arcname=arcname, filter=_tar_filter)
    return Path(tmp.name)


def _tar_filter(info: tarfile.TarInfo):
    name = info.name.replace("\\", "/")
    if "__pycache__" in name.split("/") or name.endswith(".pyc"):
        return None
    return info


def _tar_worker_code(tests_dir: Path) -> Path:
    """Pack only the files a ticket worker needs (not stage fixtures or this host's junk)."""
    tmp = tempfile.NamedTemporaryFile(prefix="ticket-tests-", suffix=".tar.gz", delete=False)
    tmp.close()
    keep = {
        "verify.py",
        "sandbox.py",
        "customer.py",
        "diagnose.py",
        "server.py",
        "llm_hook",
        "seed",
    }
    with tarfile.open(tmp.name, "w:gz") as tar:
        for name in sorted(keep):
            path = tests_dir / name
            if path.exists():
                tar.add(path, arcname=f"tests/{name}", filter=_tar_filter)
    return Path(tmp.name)


def _collect_uploads(bot_dir: Path, tests_dir: Path, seed_dir: Path, cases, rules) -> list[tuple[Path | bytes, str, bool]]:
    """Return (source, remote_path, is_temp_file) upload specs."""
    uploads = []
    bot_tar = _tar_tree(bot_dir, "bot")
    uploads.append((bot_tar, "/tmp/bot.tar.gz", True))
    code_tar = _tar_worker_code(tests_dir)
    uploads.append((code_tar, "/tmp/tests.tar.gz", True))
    if seed_dir.resolve() != (tests_dir / "seed").resolve() and seed_dir.exists():
        seed_tar = _tar_tree(seed_dir, "seed")
        uploads.append((seed_tar, "/tmp/seed.tar.gz", True))
    uploads.append((json.dumps(cases).encode(), "/tmp/job/cases.json", False))
    uploads.append((json.dumps(rules).encode(), "/tmp/job/rules.json", False))
    return uploads


def _tests_dir():
    return Path(__file__).resolve().parent


def _create_sandbox():
    from daytona import CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig

    api_key = os.environ.get("DAYTONA_API_KEY")
    if not api_key:
        raise RuntimeError("DAYTONA_API_KEY is required for TICKET_SANDBOX=daytona")
    client = Daytona(DaytonaConfig(api_key=api_key))
    snapshot = (os.environ.get("TICKET_SANDBOX_SNAPSHOT") or "").strip()
    create_timeout = float(os.environ.get("TICKET_SANDBOX_CREATE_TIMEOUT", "600"))
    if snapshot:
        params = CreateSandboxFromSnapshotParams(
            snapshot=snapshot,
            language="python",
            env_vars=_env_vars(),
            ephemeral=True,
            resources=_resources(),
        )
    else:
        params = CreateSandboxFromImageParams(
            image=_worker_image(),
            language="python",
            env_vars=_env_vars(),
            ephemeral=True,
            resources=_resources(),
        )
    sandbox = client.create(params, timeout=create_timeout)
    return client, sandbox


def _upload_and_extract(sandbox, bot_dir: Path, seed_dir: Path, cases, rules):
    tests_dir = _tests_dir()
    uploads = _collect_uploads(bot_dir, tests_dir, Path(seed_dir), cases, rules)
    temps = []
    try:
        sandbox.process.exec("mkdir -p /tmp/job /tests /app /srv/data /logs/verifier", timeout=60)
        for source, remote, is_temp in uploads:
            if is_temp:
                temps.append(source)
                sandbox.fs.upload_file(str(source), remote)
            else:
                sandbox.fs.upload_file(source, remote)
        cmds = [
            "rm -rf /app/bot",
            "mkdir -p /app /tests /tests/job",
            "tar -xzf /tmp/bot.tar.gz -C /app",
            "tar -xzf /tmp/tests.tar.gz -C /",
            "test -f /tests/verify.py",
            "cp /tmp/job/cases.json /tmp/job/rules.json /tests/job/",
            "chmod -R a+rwX /app/bot",
            "chmod -R a+rX /tests",
            "chmod a+x /app/bot/run 2>/dev/null || true",
            "chown -R bot:bot /app/bot 2>/dev/null || true",
        ]
        if any(remote == "/tmp/seed.tar.gz" for _, remote, _ in uploads):
            cmds.insert(-3, "rm -rf /tests/seed && mkdir -p /tests && tar -xzf /tmp/seed.tar.gz -C /tests")
        sandbox.process.exec(" && ".join(cmds), timeout=300)
    finally:
        for path in temps:
            Path(path).unlink(missing_ok=True)


# Daytona's list prices (per second billing; storage free up to 5 GiB). Override with the env vars for another plan.
SANDBOX_RATES = {
    "vcpu_hour": float(os.environ.get("DAYTONA_USD_PER_VCPU_HOUR", "0.0504")),
    "memory_gib_hour": float(os.environ.get("DAYTONA_USD_PER_GIB_HOUR", "0.0162")),
    "disk_gib_hour": float(os.environ.get("DAYTONA_USD_PER_DISK_GIB_HOUR", "0.000108")),
    "free_disk_gib": float(os.environ.get("DAYTONA_FREE_DISK_GIB", "5")),
}


def sandbox_cost(seconds):
    """One sandbox's size and cost for `seconds` of its life (create to delete)."""
    cpu = int(os.environ.get("TICKET_SANDBOX_CPU", "4"))
    memory = int(os.environ.get("TICKET_SANDBOX_MEMORY_GIB", "4"))
    disk = int(os.environ.get("TICKET_SANDBOX_DISK_GIB", "10"))
    r, hours = SANDBOX_RATES, seconds / 3600
    usd = hours * (cpu * r["vcpu_hour"] + memory * r["memory_gib_hour"] + max(0, disk - r["free_disk_gib"]) * r["disk_gib_hour"])
    return {"seconds": round(seconds, 1), "cpu": cpu, "memory_gib": memory, "disk_gib": disk, "usd": round(usd, 6)}


def _run_in_sandbox(cases, rules, seed_dir, bot_path, argv_extra, timeout_sec):
    """Run in a new sandbox; each result carries its share of the sandbox's life and cost (a pair splits it)."""
    start = time.monotonic()
    results = _run_in_new_sandbox(cases, rules, seed_dir, bot_path, argv_extra, timeout_sec)
    seconds = time.monotonic() - start
    whole = sandbox_cost(seconds)
    share = {**sandbox_cost(seconds / max(1, len(results))), "whole_seconds": whole["seconds"], "whole_usd": whole["usd"]}
    for r in results.values():
        if isinstance(r, dict):
            r["sandbox"] = share
    return results


def _run_in_new_sandbox(cases, rules, seed_dir, bot_path, argv_extra, timeout_sec):
    """Create sandbox, run verify.py run-one, return results dict keyed by case id."""
    client, sandbox = _create_sandbox()
    try:
        bot_dir = Path(bot_path).parent
        _upload_and_extract(sandbox, bot_dir, Path(seed_dir), cases, rules)
        out_path = "/tmp/ticket_result.json"
        cmd = [
            "python3",
            "/tests/verify.py",
            "run-one",
            "--cases",
            "/tests/job/cases.json",
            "--rules",
            "/tests/job/rules.json",
            "--seed",
            "/tests/seed",
            "--bot",
            "/app/bot/run",
            "--server",
            "/tests/server.py",
            "--data",
            "/srv/data",
            "--logs",
            "/logs/verifier",
            "--out",
            out_path,
            *argv_extra,
        ]
        # Force local backend inside the sandbox (no nested Daytona).
        response = sandbox.process.exec(
            " ".join(shlex.quote(c) for c in cmd),
            env={**_env_vars(), "TICKET_SANDBOX": "local"},
            timeout=timeout_sec,
        )
        if response.exit_code not in (0, None) and response.exit_code != 0:
            # Still try to read partial output if present.
            try:
                raw = sandbox.fs.download_file(out_path)
                payload = json.loads(raw)
                if isinstance(payload, dict) and payload.get("results"):
                    return payload["results"]
            except Exception:
                pass
            detail = (response.result or "")[-2000:]
            raise RuntimeError(f"run-one failed in sandbox (exit {response.exit_code}): {detail}")
        raw = sandbox.fs.download_file(out_path)
        payload = json.loads(raw)
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, dict) or not results:
            raise RuntimeError(f"sandbox returned no results: {raw[:500]!r}")
        return results
    finally:
        try:
            sandbox.delete()
        except Exception:
            pass


def run_solo(case, base, name, extra_text=None):
    """Run one ticket in a Daytona sandbox; return a single result dict."""
    argv = ["--case-id", case["id"], "--result-name", name]
    if extra_text:
        argv.extend(["--extra", extra_text])
    if base.get("timeout"):
        argv.extend(["--bot-timeout", str(base["timeout"])])
    rules = list(base["rules_by_id"].values())
    results = _run_in_sandbox(
        cases=[case],
        rules=rules,
        seed_dir=base["seed_dir"],
        bot_path=base.get("bot_path") or Path("/app/bot/run"),
        argv_extra=argv,
        timeout_sec=int(os.environ.get("TICKET_SANDBOX_EXEC_TIMEOUT", "1200")),
    )
    if name in results:
        return results[name]
    if case["id"] in results:
        return results[case["id"]]
    raise RuntimeError(f"sandbox missing result for {case['id']}: {sorted(results)}")


def run_pair(first, second, base, extra=None, extra_first=None):
    """Run a follow-up pair in one Daytona sandbox; return {id: result}."""
    argv = ["--pair-head", first["id"]]
    if extra:
        argv.extend(["--extra", extra])
    if extra_first:
        argv.extend(["--extra-first", extra_first])
    if base.get("timeout"):
        argv.extend(["--bot-timeout", str(base["timeout"])])
    rules = list(base["rules_by_id"].values())
    return _run_in_sandbox(
        cases=[first, second],
        rules=rules,
        seed_dir=base["seed_dir"],
        bot_path=base.get("bot_path") or Path("/app/bot/run"),
        argv_extra=argv,
        timeout_sec=int(os.environ.get("TICKET_SANDBOX_EXEC_TIMEOUT", "1200")),
    )
