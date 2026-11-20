"""Run one verifier ticket (or follow-up pair) in its own cloud sandbox: Daytona or Modal.

The stage verifier stays the Harbor orchestrator. Each ticket gets its own
4-CPU sandbox so we can fan out past local/orchestrator CPU limits.
TICKET_SANDBOX=daytona or modal picks the provider (default local: in-process threads).
Modal needs MODAL_TOKEN_ID and MODAL_TOKEN_SECRET; its sandboxes run in the app TICKET_SANDBOX_MODAL_APP
(default skyway-tickets) and count against the workspace's container limit (Starter: 100 at once).
"""

from __future__ import annotations

import atexit
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
    "WORLD_NOW",  # the stage's world time: the ticket's bot clock starts there (verify.start_world_clock)
]

# The ticket worker's Python packages (both providers' images; keep in line with tests/Dockerfile).
WORKER_PIP = ("litellm==1.103.2", "requests==2.34.2", "numpy==2.2.6", "rank-bm25==0.2.2", "networkx==3.7", "ripgrep==15.1.0", "llama-index-core==0.14.25", "llama-index-embeddings-litellm==0.6.0", "llama-index-retrievers-bm25==0.8.0", "llama-index-llms-litellm==0.8.0")
SANDBOXED = ("daytona", "modal")

# One shared declarative image build across tickets in this process.
_IMAGE_LOCK = threading.Lock()
_CACHED_IMAGE = None


def backend():
    """local = in-process threads; daytona or modal = one sandbox per ticket/pair on that provider.

    Default is local. Set TICKET_SANDBOX=daytona or TICKET_SANDBOX=modal explicitly to fan out.
    """
    mode = (os.environ.get("TICKET_SANDBOX") or "local").strip().lower()
    if mode in SANDBOXED:
        return mode
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
            .pip_install(*WORKER_PIP)
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


# Packed trees, made once and reused by every ticket while the tree is unchanged. Packing a big bot (an index can be
# 60 MB) for each of a stage's tickets kept the grader's CPU busy compressing; the files each sandbox gets are the same.
_PACKED = {}  # (kind, path) -> (signature, tar path)
_PACK_LOCK = threading.Lock()


def _signature(paths):
    """Every file's path, size and modification time under paths: it changes when any file does."""
    out = []
    for root in paths:
        root = Path(root)
        if not root.exists():
            out.append((str(root), None))
            continue
        for f in sorted([root] + list(root.rglob("*"))):
            try:
                st = f.lstat()
            except FileNotFoundError:
                continue
            out.append((str(f), st.st_size, st.st_mtime_ns, st.st_ctime_ns))  # ctime: set on any write, cannot be preserved
    return tuple(out)


def _packed(kind, path: Path, sig_paths, make):
    """The tar for (kind, path), made with make() the first time and again only when the files changed."""
    key = (kind, str(Path(path).resolve()))
    with _PACK_LOCK:
        sig = _signature(sig_paths)
        hit = _PACKED.get(key)
        if hit and hit[0] == sig and hit[1].exists():
            return hit[1]
        tar = make()
        if hit:  # another ticket may still be uploading the old archive: delete it at exit, not now
            _SUPERSEDED.append(hit[1])
        _PACKED[key] = (sig, tar)
        return tar


_SUPERSEDED = []


def _drop_packed():
    for tar in [t for _, t in _PACKED.values()] + _SUPERSEDED:
        tar.unlink(missing_ok=True)


atexit.register(_drop_packed)


# The bot reaches each ticket's sandbox through a Daytona volume: uploaded from here once per bot (an index bot is
# 80+ MB, and 70 tickets uploading it each took most of a stage's grading time), then copied inside Daytona in seconds.
# Each sandbox mounts only its own bot's folder (named by the archive's checksum), checks the copy's checksum, and
# unmounts it before the bot runs, so a bot can neither see other bots nor leave anything for later tickets. Any
# problem falls back to uploading the bot directly, as before. TICKET_SANDBOX_BOT_VOLUME=off turns it off.
BOT_MOUNT = "/mnt/bot-archive"
_VOLUME = {}  # "volume" -> Volume, or None when unavailable; "retry_at" -> when to look again after a failure
_IN_VOLUME = set()  # checksums whose archive is in the volume (uploaded by this process or found there)
_VOLUME_LOCKS = {}
_SHA = {}  # archive path -> (signature, checksum)


def _bot_volume(client):
    name = (os.environ.get("TICKET_SANDBOX_BOT_VOLUME") or "skyway-bots").strip()
    if name.lower() in ("", "off", "0", "no"):
        return None
    with _PACK_LOCK:
        if _VOLUME.get("volume") is not None:
            return _VOLUME["volume"]
        if time.monotonic() < _VOLUME.get("retry_at", 0):
            return None
        vol = None
        try:
            vol = client.volume.get(name, create=True)
            deadline = time.monotonic() + 120
            while vol.state != "ready" and time.monotonic() < deadline:
                time.sleep(3)
                vol = client.volume.get(name)
            if vol.state != "ready":
                print(f"bot volume {name} not ready ({vol.state}); uploading bots directly", flush=True)
                vol = None
        except Exception as exc:  # noqa: BLE001 - fall back to direct upload
            print(f"bot volume {name} unavailable ({exc}); uploading bots directly", flush=True)
            vol = None
        _VOLUME["volume"] = vol
        if vol is None:  # a passing problem should not turn the volume off for the whole stage
            _VOLUME["retry_at"] = time.monotonic() + 60
        return vol


def _checksum(tar: Path):
    import hashlib
    st = tar.stat()
    sig = (st.st_size, st.st_mtime_ns)
    hit = _SHA.get(str(tar))
    if hit and hit[0] == sig:
        return hit[1]
    h = hashlib.sha256()
    with open(tar, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    _SHA[str(tar)] = (sig, h.hexdigest())
    return h.hexdigest()


class VolumeStillMounted(RuntimeError):
    """The bot volume could not be unmounted: this sandbox must not run the bot."""


def _bot_from_volume(sandbox, tar: Path, sha: str) -> bool:
    """Put the bot archive at /tmp/bot.tar.gz from the mounted volume (uploading it there first if needed). False
    when anything is off: the caller then uploads it directly. Raises VolumeStillMounted when the volume cannot be
    unmounted (the caller then uses a fresh sandbox without it)."""
    src = f"{BOT_MOUNT}/bot.tar.gz"
    copy = f"cp {src} /tmp/bot.tar.gz && sha256sum /tmp/bot.tar.gz | cut -d' ' -f1"
    try:
        with _PACK_LOCK:
            lock = _VOLUME_LOCKS.setdefault(sha, threading.Lock())
        with lock:
            if sha in _IN_VOLUME:
                got = sandbox.process.exec(copy, timeout=300).result.strip()
            else:
                # Adopt a file already there only if its contents match; otherwise (missing or damaged) upload it.
                got = sandbox.process.exec(f"test -f {src} && {copy} || echo missing", timeout=300).result.strip()
                if got != sha:
                    sandbox.fs.upload_file(str(tar), src)
                    got = sandbox.process.exec(copy, timeout=300).result.strip()
                if got == sha:
                    _IN_VOLUME.add(sha)
        if got != sha:
            print(f"bot archive in the volume does not match ({got[:12]} != {sha[:12]}); uploading directly", flush=True)
            with _PACK_LOCK:
                _IN_VOLUME.discard(sha)  # the next ticket checks the volume file again and replaces it if needed
            return False
        return True
    except Exception as exc:  # noqa: BLE001 - fall back to direct upload
        print(f"bot volume copy failed ({exc}); uploading directly", flush=True)
        return False
    finally:
        # The bot never sees the volume: unmount it, and check that it is gone.
        left = "error"
        try:
            left = sandbox.process.exec(
                f"umount {BOT_MOUNT} 2>/dev/null || umount -l {BOT_MOUNT} 2>/dev/null; rmdir {BOT_MOUNT} 2>/dev/null; "
                f"grep -c ' {BOT_MOUNT} ' /proc/mounts || true", timeout=60).result.strip()
        except Exception:  # noqa: BLE001
            pass
        if left != "0":
            raise VolumeStillMounted(f"bot volume still mounted ({left})")


def _collect_uploads(bot_dir: Path, tests_dir: Path, seed_dir: Path, cases, rules) -> list[tuple[Path | bytes, str, bool]]:
    """Return (source, remote_path, is_temp_file) upload specs. The tars are shared (see _packed): not temp files."""
    uploads = []
    bot_tar = _packed("bot", bot_dir, [bot_dir], lambda: _tar_tree(bot_dir, "bot"))
    uploads.append((bot_tar, "/tmp/bot.tar.gz", False))
    code_tar = _packed("tests", tests_dir, [tests_dir], lambda: _tar_worker_code(tests_dir))
    uploads.append((code_tar, "/tmp/tests.tar.gz", False))
    if seed_dir.resolve() != (tests_dir / "seed").resolve() and seed_dir.exists():
        seed_tar = _packed("seed", seed_dir, [seed_dir], lambda: _tar_tree(seed_dir, "seed"))
        uploads.append((seed_tar, "/tmp/seed.tar.gz", False))
    uploads.append((json.dumps(cases).encode(), "/tmp/job/cases.json", False))
    uploads.append((json.dumps(rules).encode(), "/tmp/job/rules.json", False))
    return uploads


def _tests_dir():
    return Path(__file__).resolve().parent


def _create_sandbox(bot_tar: Path | None = None):
    """A new ticket sandbox. With bot_tar, it also mounts that bot's folder of the bot volume (see _bot_from_volume);
    returns (client, sandbox, checksum or None)."""
    from daytona import CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig, VolumeMount

    api_key = os.environ.get("DAYTONA_API_KEY")
    if not api_key:
        raise RuntimeError("DAYTONA_API_KEY is required for TICKET_SANDBOX=daytona")
    client = Daytona(DaytonaConfig(api_key=api_key))
    snapshot = (os.environ.get("TICKET_SANDBOX_SNAPSHOT") or "").strip()
    create_timeout = float(os.environ.get("TICKET_SANDBOX_CREATE_TIMEOUT", "600"))
    sha, mounts = None, []
    if bot_tar is not None:
        vol = _bot_volume(client)
        if vol is not None:
            sha = _checksum(bot_tar)
            mounts = [VolumeMount(volume_id=vol.id, mount_path=BOT_MOUNT, subpath=sha)]
    extra = {"volumes": mounts} if mounts else {}
    if snapshot:
        params = CreateSandboxFromSnapshotParams(
            snapshot=snapshot,
            language="python",
            env_vars=_env_vars(),
            ephemeral=True,
            resources=_resources(),
            **extra,
        )
    else:
        params = CreateSandboxFromImageParams(
            image=_worker_image(),
            language="python",
            env_vars=_env_vars(),
            ephemeral=True,
            resources=_resources(),
            **extra,
        )
    sandbox = client.create(params, timeout=create_timeout)
    return client, sandbox, sha


def _upload_and_extract(sandbox, bot_dir: Path, seed_dir: Path, cases, rules, sha=None):
    tests_dir = _tests_dir()
    uploads = _collect_uploads(bot_dir, tests_dir, Path(seed_dir), cases, rules)
    temps = []
    try:
        sandbox.process.exec("mkdir -p /tmp/job /tests /app /srv/data /logs/verifier", timeout=60)
        if sha is not None:
            bot_tar = Path(next(src for src, remote, _ in uploads if remote == "/tmp/bot.tar.gz"))
            # The mounted folder is this checksum's: use it only for the same archive (the bot may have been packed
            # again since the sandbox was created).
            if _checksum(bot_tar) == sha and _bot_from_volume(sandbox, bot_tar, sha):
                uploads = [u for u in uploads if u[1] != "/tmp/bot.tar.gz"]
        for source, remote, is_temp in uploads:
            if is_temp:
                temps.append(source)
                sandbox.fs.upload_file(str(source), remote)
            else:
                sandbox.fs.upload_file(str(source) if isinstance(source, Path) else source, remote)
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


# Daytona's list prices (per second billing; storage free up to 5 GiB). Override with the env vars for another plan
# or provider (a Modal run reports its sandboxes at these rates unless they are set to Modal's).
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


# ------------------------------------------------------------------ Modal
_MODAL = {}  # "app" -> App, "image" -> Image (one per process)
_MODAL_LOCK = threading.Lock()


def _modal_image_and_app():
    """The ticket worker image (as _worker_image, for Modal) and the app its sandboxes run in."""
    import modal

    with _MODAL_LOCK:
        if "app" not in _MODAL:
            if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
                raise RuntimeError("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required for TICKET_SANDBOX=modal")
            name = (os.environ.get("TICKET_SANDBOX_MODAL_APP") or "skyway-tickets").strip()
            _MODAL["app"] = modal.App.lookup(name, create_if_missing=True)
            override = (os.environ.get("TICKET_SANDBOX_IMAGE") or "").strip()
            _MODAL["image"] = (
                modal.Image.from_registry(override) if override else
                modal.Image.debian_slim(python_version="3.12")
                .pip_install(*WORKER_PIP)
                .run_commands(
                    "useradd --create-home --shell /bin/bash bot || true",
                    "mkdir -p /tests /app /srv/data /logs/verifier /tmp/job",
                )
                .env({"LITELLM_LOCAL_MODEL_COST_MAP": "True"})
                .workdir("/tests")
            )
        return _MODAL["image"], _MODAL["app"]


class _ModalBox:
    """A Modal sandbox with the three things a ticket needs: run a command, put a file in, get a file out."""

    def __init__(self, timeout_sec):
        import modal

        image, app = _modal_image_and_app()
        cpu = float(os.environ.get("TICKET_SANDBOX_CPU", "4"))
        memory = int(os.environ.get("TICKET_SANDBOX_MEMORY_GIB", "4")) * 1024
        # The sandbox ends itself after its timeout even if this process is gone: never left running.
        self.sb = modal.Sandbox.create(
            "sleep", "infinity", app=app, image=image, cpu=cpu, memory=memory,
            timeout=int(timeout_sec) + 900, env={**_env_vars(), "TICKET_SANDBOX": "local"},
        )

    def run(self, cmd, timeout):
        """(exit code, combined output) of a shell command."""
        p = self.sb.exec("bash", "-c", f"{cmd} 2>&1", timeout=int(timeout))
        out = p.stdout.read()
        code = p.wait()
        return code, out

    def put(self, source, remote):
        if isinstance(source, (bytes, bytearray)):
            self.sb.filesystem.write_bytes(bytes(source), remote)
        else:
            self.sb.filesystem.copy_from_local(str(source), remote)

    def get(self, remote):
        return self.sb.filesystem.read_bytes(remote)

    def delete(self):
        self.sb.terminate()


def _run_in_new_modal_sandbox(cases, rules, seed_dir, bot_path, argv_extra, timeout_sec):
    """As _run_in_new_sandbox, on Modal: create, upload, run verify.py run-one, read the results, terminate."""
    bot_dir = Path(bot_path).parent
    box = _ModalBox(timeout_sec)
    try:
        uploads = _collect_uploads(bot_dir, _tests_dir(), Path(seed_dir), cases, rules)
        box.run("mkdir -p /tmp/job /tests /app /srv/data /logs/verifier", 60)
        for source, remote, _ in uploads:
            box.put(source, remote)
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
        code, out = box.run(" && ".join(cmds), 300)
        if code != 0:
            raise RuntimeError(f"ticket sandbox setup failed (exit {code}): {out[-1500:]}")
        out_path = "/tmp/ticket_result.json"
        cmd = ["python3", "/tests/verify.py", "run-one", "--cases", "/tests/job/cases.json", "--rules",
               "/tests/job/rules.json", "--seed", "/tests/seed", "--bot", "/app/bot/run", "--server", "/tests/server.py",
               "--data", "/srv/data", "--logs", "/logs/verifier", "--out", out_path, *argv_extra]
        code, out = box.run(" ".join(shlex.quote(c) for c in cmd), timeout_sec)
        try:
            payload = json.loads(box.get(out_path))
        except Exception:  # noqa: BLE001
            payload = None
        results = payload.get("results") if isinstance(payload, dict) else None
        if isinstance(results, dict) and results:
            return results  # also after a non-zero exit: partial output still counts, as on Daytona
        raise RuntimeError(f"run-one failed in sandbox (exit {code}): {(out or '')[-2000:]}")
    finally:
        try:
            box.delete()
        except Exception:  # noqa: BLE001
            pass


def _run_in_sandbox(cases, rules, seed_dir, bot_path, argv_extra, timeout_sec):
    """Run in a new sandbox; each result carries its share of the sandbox's life and cost (a pair splits it)."""
    start = time.monotonic()
    run = _run_in_new_modal_sandbox if backend() == "modal" else _run_in_new_sandbox
    results = run(cases, rules, seed_dir, bot_path, argv_extra, timeout_sec)
    seconds = time.monotonic() - start
    whole = sandbox_cost(seconds)
    share = {**sandbox_cost(seconds / max(1, len(results))), "whole_seconds": whole["seconds"], "whole_usd": whole["usd"]}
    for r in results.values():
        if isinstance(r, dict):
            r["sandbox"] = share
    return results


def _run_in_new_sandbox(cases, rules, seed_dir, bot_path, argv_extra, timeout_sec):
    """Create sandbox, run verify.py run-one, return results dict keyed by case id."""
    bot_dir = Path(bot_path).parent
    bot_tar = _packed("bot", bot_dir, [bot_dir], lambda: _tar_tree(bot_dir, "bot"))
    try:
        client, sandbox, sha = _create_sandbox(bot_tar)
    except Exception as exc:  # noqa: BLE001 - the volume mount may be what failed: try once without it
        if _VOLUME.get("volume") is None:
            raise
        print(f"sandbox with the bot volume could not be created ({exc}); creating one without it", flush=True)
        client, sandbox, sha = _create_sandbox(None)
    try:
        try:
            _upload_and_extract(sandbox, bot_dir, Path(seed_dir), cases, rules, sha=sha)
        except VolumeStillMounted as exc:
            print(f"{exc}; using a fresh sandbox without the volume", flush=True)
            try:
                sandbox.delete()
            except Exception:  # noqa: BLE001
                pass
            client, sandbox, sha = _create_sandbox(None)
            _upload_and_extract(sandbox, bot_dir, Path(seed_dir), cases, rules, sha=None)
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


def run_solo(case, base, name):
    """Run one ticket in its own sandbox (Daytona or Modal); return a single result dict."""
    argv = ["--case-id", case["id"]]
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


def run_pair(first, second, base):
    """Run a follow-up pair in one sandbox (Daytona or Modal); return {id: result}."""
    argv = ["--pair-head", first["id"]]
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
