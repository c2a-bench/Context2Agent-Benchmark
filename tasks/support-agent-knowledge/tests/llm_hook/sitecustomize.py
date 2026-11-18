"""Loaded automatically by Python (via PYTHONPATH) in every bot process.

Observes every litellm call. The only behaviour change: if BOT_PROMPT_CAP_TOKENS
is set, an oversized completion is refused before it is sent.

Appends one JSON line per event to $OBSERVE_TRACE:
  llm        every litellm.completion / acompletion call (model, messages, tool names, reply, token use and cost)
  embedding  every litellm.embedding / aembedding call (model, number of inputs)
  open       first open of each non-library file (path, write or read)
  import     each non-stdlib top-level module, and whether the bot's own code or a library imported it
  connect    first connection to each network address
  exec       every program started (subprocess / os.system)
  start      a new Python process started
"""

import importlib.abc
import importlib.util
import json
import os
import sys
import threading
import time

import observe_usage
import prompt_cap

TRACE = os.environ.get("OBSERVE_TRACE")
# Replays only: guidance from the grader (the rule, what the customer has told us), appended on every model call
# to the end of the bot's own system message, the channel the bot trusts. Customer text is where injection tickets hide fake instructions.
HINT = os.environ.get("BOT_SYSTEM_HINT", "").strip()
_state = threading.local()
_lock = threading.Lock()
_seen = set()
_fd = None
_SKIP_PREFIXES = tuple({sys.prefix, sys.base_prefix, "/usr/", "/proc", "/dev", "/sys", "/etc", "/lib", "/bin", "/sbin"})
_SKIP_SUFFIXES = (".py", ".pyc", ".so", ".pth", ".dist-info", ".egg-info")


def _write(entry):
    if _fd is None:
        return
    entry["t"] = round(time.time(), 3)
    entry["pid"] = os.getpid()
    data = (json.dumps(entry, default=str) + "\n").encode()
    _state.busy = True
    try:
        with _lock:
            os.write(_fd, data)
    except OSError:
        pass
    finally:
        _state.busy = False


def _once(key, entry):
    if key in _seen:
        return
    _seen.add(key)
    _write(entry)


def _on_open(args):
    path, mode, flags = (list(args) + [None, None, None])[:3]
    if not isinstance(path, (str, bytes, os.PathLike)):
        return
    path = os.path.abspath(os.fsdecode(path))
    if path.startswith(_SKIP_PREFIXES) or path.endswith(_SKIP_SUFFIXES) or "__pycache__" in path or path == TRACE:
        return
    write = bool(mode and any(c in str(mode) for c in "wax+")) or bool(
        isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR)
    )
    _once(("open", path, write), {"kind": "open", "path": path, "write": write, "by_library": _library_caller(sys._getframe(2))})


_STDLIB = os.path.dirname(os.__file__)


def _library_caller(frame):
    """True unless the nearest non-stdlib frame is the bot's own code (not an installed package, not Python startup)."""
    while frame is not None:
        name = frame.f_code.co_filename
        in_stdlib = name.startswith(_STDLIB) and "-packages" not in name
        if name != __file__ and not in_stdlib and not name.startswith("<"):
            return "site-packages" in name or "dist-packages" in name
        frame = frame.f_back
    return True


def _note_import(name, frame):
    top = str(name).split(".")[0]
    if not top or top in sys.stdlib_module_names or top.startswith("_") or getattr(_state, "busy", False):
        return
    if ("import", top, False) in _seen:
        return
    _state.busy = True
    try:
        by_library = _library_caller(frame)
    finally:
        _state.busy = False
    _once(("import", top, by_library), {"kind": "import", "module": top, "by_library": by_library})


def _install_import_watch():
    """Every `import` statement and importlib.import_module call, even for modules already loaded."""
    import builtins
    import importlib

    original_import, original_import_module = builtins.__import__, importlib.import_module

    def watched_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and name:
            _note_import(name, sys._getframe(1))
        return original_import(name, globals, locals, fromlist, level)

    def watched_import_module(name, package=None):
        if name and not name.startswith("."):
            _note_import(name, sys._getframe(1))
        return original_import_module(name, package)

    builtins.__import__ = watched_import
    importlib.import_module = watched_import_module


def _audit(event, args):
    if getattr(_state, "busy", False):
        return
    try:
        if event == "open":
            _on_open(args)
        elif event == "socket.connect" and len(args) > 1:
            _once(("connect", str(args[1])), {"kind": "connect", "address": str(args[1])})
        elif event == "subprocess.Popen":
            _write({"kind": "exec", "program": str(args[0]), "args": [str(a) for a in list(args[1] or [])[:6]]})
        elif event == "os.system":
            _write({"kind": "exec", "program": "sh", "args": [str(args[0])[:300]]})
    except Exception:
        pass


def _reply(resp):
    try:
        msg = resp.choices[0].message
        calls = [{"name": t.function.name, "arguments": t.function.arguments} for t in (msg.tool_calls or [])]
        return {"content": msg.content, "tool_calls": calls}
    except Exception:
        return {"content": "<reply could not be read>", "tool_calls": []}


def _tool_names(tools):
    names = []
    for t in tools or []:
        fn = t.get("function", t) if isinstance(t, dict) else {}
        names.append(fn.get("name"))
    return names


def _llm_entry(args, kwargs):
    return {
        "kind": "llm",
        "model": kwargs.get("model", args[0] if args else None),
        "messages": kwargs.get("messages", args[1] if len(args) > 1 else None),
        "tools": _tool_names(kwargs.get("tools")),
        "stream": bool(kwargs.get("stream")),
    }


def _with_hint(args, kwargs):
    """args/kwargs with HINT appended to the end of the bot's own system message (the last of its leading system
    messages), so it reads as part of the bot's instructions; a bot with no system message gets one."""
    messages = kwargs.get("messages", args[1] if len(args) > 1 else None)
    if not HINT or not isinstance(messages, list):
        return args, kwargs
    at = 0
    while at < len(messages) and isinstance(messages[at], dict) and messages[at].get("role") == "system":
        at += 1
    if at == 0:
        messages = [{"role": "system", "content": HINT}] + messages
    else:
        last = dict(messages[at - 1])
        content = last.get("content")
        if isinstance(content, list):  # content parts
            last["content"] = content + [{"type": "text", "text": "\n\n" + HINT}]
        else:
            last["content"] = (f"{content}\n\n" if content else "") + HINT
        messages = messages[:at - 1] + [last] + messages[at:]
    if "messages" in kwargs or len(args) < 2:
        return args, {**kwargs, "messages": messages}
    return (args[0], messages, *args[2:]), kwargs


def _llm_finish(entry, start, resp=None, error=None):
    entry["seconds"] = round(time.time() - start, 2)
    if error is not None:
        entry["error"] = f"{type(error).__name__}: {error}"[:500]
    elif entry["stream"]:
        entry["reply"] = {"content": "<streamed reply, not recorded>", "tool_calls": []}
    else:
        entry["reply"] = _reply(resp)
        entry["usage"] = observe_usage.usage_of(resp)
    _write(entry)


def _emb_entry(args, kwargs):
    inputs = kwargs.get("input", args[1] if len(args) > 1 else None)
    return {"kind": "embedding", "model": kwargs.get("model", args[0] if args else None),
            "inputs": len(inputs) if isinstance(inputs, list) else 1}


def _wrap(fn, make_entry, finish, is_async):
    if is_async:
        async def wrapper(*args, **kwargs):
            if make_entry is _llm_entry:
                args, kwargs = _with_hint(args, kwargs)
            start, entry = time.time(), make_entry(args, kwargs)
            try:
                if make_entry is _llm_entry:
                    entry["prompt_tokens"] = prompt_cap.enforce(
                        kwargs.get("messages", args[1] if len(args) > 1 else None),
                        kwargs.get("tools"),
                    )
                resp = await fn(*args, **kwargs)
            except Exception as e:
                finish(entry, start, error=e)
                raise
            finish(entry, start, resp=resp)
            return resp
    else:
        def wrapper(*args, **kwargs):
            if make_entry is _llm_entry:
                args, kwargs = _with_hint(args, kwargs)
            start, entry = time.time(), make_entry(args, kwargs)
            try:
                if make_entry is _llm_entry:
                    entry["prompt_tokens"] = prompt_cap.enforce(
                        kwargs.get("messages", args[1] if len(args) > 1 else None),
                        kwargs.get("tools"),
                    )
                resp = fn(*args, **kwargs)
            except Exception as e:
                finish(entry, start, error=e)
                raise
            finish(entry, start, resp=resp)
            return resp
    return wrapper


def _emb_finish(entry, start, resp=None, error=None):
    entry["seconds"] = round(time.time() - start, 2)
    if error is not None:
        entry["error"] = f"{type(error).__name__}: {error}"[:500]
    _write(entry)


def _patch(module):
    for name, make, finish, is_async in (
        ("completion", _llm_entry, _llm_finish, False),
        ("acompletion", _llm_entry, _llm_finish, True),
        ("embedding", _emb_entry, _emb_finish, False),
        ("aembedding", _emb_entry, _emb_finish, True),
    ):
        if hasattr(module, name):
            setattr(module, name, _wrap(getattr(module, name), make, finish, is_async))


class _LitellmFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != "litellm":
            return None
        sys.meta_path.remove(self)
        spec = importlib.util.find_spec(name)
        if spec is None or spec.loader is None:
            return spec
        original = spec.loader.exec_module

        def exec_module(module):
            original(module)
            _patch(module)

        spec.loader.exec_module = exec_module
        return spec


if TRACE:
    _state.busy = True
    try:
        _fd = os.open(TRACE, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    except OSError:
        _fd = None
    _state.busy = False
    if _fd is not None:
        sys.meta_path.insert(0, _LitellmFinder())
        sys.addaudithook(_audit)
        _install_import_watch()
        _write({"kind": "start", "program": sys.executable})
