"""Loaded automatically by Python (via PYTHONPATH) in every bot process.

Observes every litellm call. Behaviour changes: every completion uses BOT_MODEL with the model's own settings (any
model, reasoning effort, temperature or similar the bot passes is dropped, and recorded as "overridden"), so builders
cannot tune the model; if BOT_PROMPT_CAP_TOKENS is set, an oversized completion is refused before it is sent; if
BOT_CLOCK_OFFSET is set, the bot's clocks show the stage's world time (world_clock.py).

Appends one JSON line per event to $OBSERVE_TRACE:
  llm        every litellm.completion / acompletion call (model, messages, tool names, reply, token use and cost)
  embedding  every litellm.embedding / aembedding call (model, number of inputs)
  open       first open of each non-library file (path, write or read)
  import     each non-stdlib top-level module, and whether the bot's own code or a library imported it
  connect    first connection to each network address
  exec       every program started (subprocess / os.system)
  start      a new Python process started
"""

import contextvars
import importlib.abc
import importlib.util
import inspect
import json
import os
import sys
import threading
import time

import observe_usage
import prompt_cap
import world_clock

_real_time = world_clock.real_time  # the trace's own times stay real: the grader matches calls to bot runs by them

TRACE = os.environ.get("OBSERVE_TRACE")
# The model every completion uses, with its own default settings: a builder cannot change the model or tune it.
BOT_MODEL = os.environ.get("BOT_MODEL", "").strip()
FIXED_SETTINGS = ("reasoning_effort", "reasoning", "thinking", "temperature", "top_p", "top_k", "seed",
                  "frequency_penalty", "presence_penalty", "logit_bias",
                  # where the call goes: always the provider's own endpoint for BOT_MODEL
                  "api_base", "base_url", "custom_llm_provider")
_state = threading.local()
# Set while a wrapped model call runs: litellm's acompletion runs its own completion inside (in the same context),
# and that inner call must not be fixed or recorded a second time.
_inside_call = contextvars.ContextVar("observe_inside_call", default=False)
_lock = threading.Lock()
_seen = set()
_fd = None
_SKIP_PREFIXES = tuple({sys.prefix, sys.base_prefix, "/usr/", "/proc", "/dev", "/sys", "/etc", "/lib", "/bin", "/sbin"})
_SKIP_SUFFIXES = (".py", ".pyc", ".so", ".pth", ".dist-info", ".egg-info")


def _write(entry):
    if _fd is None:
        return
    entry["t"] = round(_real_time(), 3)
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


def _as_keywords(fn, args, kwargs):
    """All arguments by name, using litellm's own signature (completion(model, messages, timeout, temperature, ...)
    takes settings by position too), so a setting is fixed however the bot passed it."""
    if not args:
        return args, kwargs
    try:
        bound = inspect.signature(fn).bind_partial(*args, **kwargs)
    except (TypeError, ValueError):
        return args, kwargs
    named = {}
    for name, value in bound.arguments.items():
        kind = bound.signature.parameters[name].kind
        if kind is inspect.Parameter.VAR_KEYWORD:
            named.update(value)
        elif kind is inspect.Parameter.VAR_POSITIONAL:
            return args, kwargs  # cannot name these; leave the call as it was
        else:
            named[name] = value
    return (), named


def _fixed_settings(args, kwargs):
    """args/kwargs with the model set to BOT_MODEL and the bot's own model settings removed, plus what was changed."""
    overridden = {}
    kwargs = dict(kwargs)
    for key in FIXED_SETTINGS:
        if key in kwargs:
            value = kwargs.pop(key)
            if value is not None:
                overridden[key] = value
    extra = kwargs.get("extra_body")
    if isinstance(extra, dict) and any(k in extra for k in FIXED_SETTINGS):  # the same settings sent in the body
        extra = dict(extra)
        for key in FIXED_SETTINGS:
            if key in extra:
                overridden[f"extra_body.{key}"] = extra.pop(key)
        kwargs["extra_body"] = extra
    if BOT_MODEL:
        if "model" in kwargs or not args:
            if kwargs.get("model") != BOT_MODEL:
                overridden["model"] = kwargs.get("model")
                kwargs["model"] = BOT_MODEL
        elif args[0] != BOT_MODEL:
            overridden["model"] = args[0]
            args = (BOT_MODEL, *args[1:])
    return args, kwargs, overridden


def _llm_finish(entry, start, resp=None, error=None):
    entry["seconds"] = round(_real_time() - start, 2)
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
            if make_entry in (_llm_entry, _resp_entry) and _inside_call.get():
                return await fn(*args, **kwargs)
            token = _inside_call.set(True) if make_entry in (_llm_entry, _resp_entry) else None
            try:
                return await _run_async(args, kwargs)
            finally:
                if token is not None:
                    _inside_call.reset(token)

        async def _run_async(args, kwargs):
            overridden = {}
            if make_entry in (_llm_entry, _resp_entry):
                args, kwargs = _as_keywords(fn, args, kwargs)
                args, kwargs, overridden = _fixed_settings(args, kwargs)
            start, entry = _real_time(), make_entry(args, kwargs)
            if overridden:
                entry["overridden"] = {k: str(v)[:200] for k, v in overridden.items()}
            try:
                if make_entry is _llm_entry:
                    entry["prompt_tokens"] = prompt_cap.enforce(
                        kwargs.get("messages", args[1] if len(args) > 1 else None),
                        kwargs.get("tools"),
                    )
                elif make_entry is _resp_entry:  # the Responses API's input: a string or a list of messages
                    given = kwargs.get("input", args[1] if len(args) > 1 else None)
                    entry["prompt_tokens"] = prompt_cap.enforce(
                        given if isinstance(given, list) else [{"content": str(given or "")}], kwargs.get("tools"))
                resp = await fn(*args, **kwargs)
            except Exception as e:
                finish(entry, start, error=e)
                raise
            finish(entry, start, resp=resp)
            return resp
    else:
        def wrapper(*args, **kwargs):
            if make_entry in (_llm_entry, _resp_entry) and _inside_call.get():
                return fn(*args, **kwargs)
            token = _inside_call.set(True) if make_entry in (_llm_entry, _resp_entry) else None
            try:
                return _run_sync(args, kwargs)
            finally:
                if token is not None:
                    _inside_call.reset(token)

        def _run_sync(args, kwargs):
            overridden = {}
            if make_entry in (_llm_entry, _resp_entry):
                args, kwargs = _as_keywords(fn, args, kwargs)
                args, kwargs, overridden = _fixed_settings(args, kwargs)
            start, entry = _real_time(), make_entry(args, kwargs)
            if overridden:
                entry["overridden"] = {k: str(v)[:200] for k, v in overridden.items()}
            try:
                if make_entry is _llm_entry:
                    entry["prompt_tokens"] = prompt_cap.enforce(
                        kwargs.get("messages", args[1] if len(args) > 1 else None),
                        kwargs.get("tools"),
                    )
                elif make_entry is _resp_entry:  # the Responses API's input: a string or a list of messages
                    given = kwargs.get("input", args[1] if len(args) > 1 else None)
                    entry["prompt_tokens"] = prompt_cap.enforce(
                        given if isinstance(given, list) else [{"content": str(given or "")}], kwargs.get("tools"))
                resp = fn(*args, **kwargs)
            except Exception as e:
                finish(entry, start, error=e)
                raise
            finish(entry, start, resp=resp)
            return resp
    return wrapper


def _emb_finish(entry, start, resp=None, error=None):
    entry["seconds"] = round(_real_time() - start, 2)
    if error is not None:
        entry["error"] = f"{type(error).__name__}: {error}"[:500]
    _write(entry)


def _resp_entry(args, kwargs):
    """litellm.responses (the Responses API): recorded as a model call; its reply is not parsed."""
    return {"kind": "llm", "api": "responses", "model": kwargs.get("model", args[0] if args else None),
            "messages": kwargs.get("input", args[1] if len(args) > 1 else None),
            "tools": _tool_names(kwargs.get("tools")), "stream": bool(kwargs.get("stream"))}


def _resp_finish(entry, start, resp=None, error=None):
    entry["seconds"] = round(_real_time() - start, 2)
    if error is not None:
        entry["error"] = f"{type(error).__name__}: {error}"[:500]
    else:
        entry["usage"] = observe_usage.usage_of(resp)
    _write(entry)


def _patch(module):
    wrapped = {}
    for name, make, finish, is_async in (
        ("completion", _llm_entry, _llm_finish, False),
        ("acompletion", _llm_entry, _llm_finish, True),
        ("responses", _resp_entry, _resp_finish, False),
        ("aresponses", _resp_entry, _resp_finish, True),
        ("embedding", _emb_entry, _emb_finish, False),
        ("aembedding", _emb_entry, _emb_finish, True),
    ):
        if hasattr(module, name):
            wrapped[name] = _wrap(getattr(module, name), make, finish, is_async)
            setattr(module, name, wrapped[name])
    # text_completion, batch_completion, completion_with_retries call litellm.main's own completion, not the
    # package's: point those names at the same wrappers so every completion path is fixed and recorded once.
    main = sys.modules.get("litellm.main")
    if main is not None:
        for name in ("completion", "acompletion"):
            if name in wrapped and hasattr(main, name):
                setattr(main, name, wrapped[name])


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


# The world's clock: the stage's "now" (BOT_CLOCK_OFFSET from the grader), installed before the bot imports anything.
try:
    _clock_offset = float(os.environ.get("BOT_CLOCK_OFFSET") or "")
except ValueError:
    _clock_offset = None
if _clock_offset is not None:
    world_clock.install(_clock_offset)

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
