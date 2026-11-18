"""Count tokens the same way the report does (characters / 4) and refuse an oversized bot call.

Used only when BOT_PROMPT_CAP_TOKENS is set on the bot process. The customer
model never sees this. Replay does not set the env.
"""

import json
import os


class PromptCapError(Exception):
    """Looks like a provider context-length error so the bot can catch and retry smaller."""


def message_text(messages):
    parts = []
    for message in messages or []:
        if not isinstance(message, dict):
            parts.append(str(message))
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        parts.append(str(content or ""))
        for call in message.get("tool_calls") or []:
            fn = call.get("function", call) if isinstance(call, dict) else {}
            parts.append(f"{fn.get('name') or ''} {fn.get('arguments') or ''}")
    return " ".join(parts)


def prompt_tokens(messages, tools=None):
    text = message_text(messages)
    if tools:
        text += json.dumps(tools, default=str)
    return (len(text) + 3) // 4


def cap_from_env():
    raw = (os.environ.get("BOT_PROMPT_CAP_TOKENS") or "").strip()
    if not raw:
        return None
    return int(raw)


def enforce(messages, tools=None, cap=None):
    """Raise PromptCapError when the prompt is over the cap. No cap means allow."""
    if cap is None:
        cap = cap_from_env()
    if cap is None:
        return prompt_tokens(messages, tools)
    used = prompt_tokens(messages, tools)
    if used > cap:
        raise PromptCapError(
            f"This model's maximum context length is {cap} tokens. "
            f"Your request is {used} tokens long."
        )
    return used


def self_check():
    short = [{"role": "user", "content": "abcd" * 100}]
    if prompt_tokens(short) != 100:
        raise SystemExit(f"prompt_cap: expected 100 tokens, got {prompt_tokens(short)}")
    enforce(short, cap=8000)
    try:
        enforce([{"role": "user", "content": "x" * 40000}], cap=8000)
    except PromptCapError:
        return
    raise SystemExit("prompt_cap: oversized prompt was not refused")
