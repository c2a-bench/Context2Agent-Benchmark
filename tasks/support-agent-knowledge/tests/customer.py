"""The customer the support bot can talk to.

The opening and the fact list are a private note. The builder never sees them.
The customer says the opening first. It uses the list only when support asks.
It hears only what the bot puts in `reply`; nothing it says is written to the ticket.
It does not see the company docs or the right answer. If the call fails, the
ticket is left out of the score.

Optional `behavior` on a case adds a persona rule (missing info, resistance,
linguistic register, etc.) without changing the underlying facts or filing.
"""

import json
import os
import re

MAX_REPLIES = 5
PRIORITY = re.compile(r"\bP[0-4]\b")

SYSTEM = """You are the customer who opened this support ticket. Write the way that person would write.

Your first message uses only the opening. Do not add the facts until support asks a question.

Opening:
{opening}

Facts you may use if support asks:
{facts}

If support asks for something not in the opening or the facts, say you don't know.
You see only what support writes to you. "Support did not reply." means support sent you nothing since your last message.
{behavior_block}
{extra_rule}
Reply with only a JSON object: {{"reply": "{reply_shape}"}}"""

LIVE_RULE = "Do not mention priority codes, team names, or ticket labels. Do not guess how the company should file the ticket."

# Persona overlays for the user-behavior stage. Empty string = default customer.
BEHAVIOR_RULES = {
    "normal": "",
    "missing_info": (
        "Keep the first message short and vague. Only share a fact when support "
        "clearly asks for it. Prefer one fact per reply."
    ),
    "ambiguous": (
        "Your opening can reasonably be read more than one way. Do not clarify "
        "which reading is right until support asks a direct question. Then answer "
        "from the facts."
    ),
    "conflict": (
        "The opening may not match the facts. When support asks clarifying "
        "questions, answer from the facts. Do not volunteer that the opening was "
        "wrong or incomplete."
    ),
    "escalate": (
        "You are frustrated and push for faster, more urgent help. Repeat that "
        "this is blocking you. Still do not invent facts, and still do not name "
        "priority codes, teams, or labels."
    ),
    "ling_casual": (
        "Write casually: short lines, contractions, informal tone. Light typos "
        "are fine. Do not change the underlying facts."
    ),
    "ling_formal": (
        "Write formally: complete sentences, polite register, no slang. Do not "
        "change the underlying facts."
    ),
}


def behavior_block(behavior):
    rule = BEHAVIOR_RULES.get((behavior or "").strip(), "")
    if not rule and (behavior or "").strip() and (behavior or "").strip() not in BEHAVIOR_RULES:
        rule = str(behavior).strip()
    return f"How you write and behave:\n{rule}\n" if rule else ""


def prompt(opening, facts, behavior=None):
    lines = [f"- {line}" for line in facts if str(line).strip()]
    return SYSTEM.format(
        opening=opening.strip(),
        facts="\n".join(lines) if lines else "- You have nothing else to add.",
        behavior_block=behavior_block(behavior),
        extra_rule=LIVE_RULE,
        reply_shape="one or two sentences",
    )


def judge(raw):
    """Turn the customer model's text into a reply, or a reason the call failed."""
    text = (raw or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {"fault": "The customer model did not return a reply."}
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {"fault": "The customer model did not return a reply."}
    if not isinstance(data, dict):
        return {"fault": "The customer model did not return a reply."}
    reply = data.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        return {"fault": "The customer model returned an empty reply."}
    return {"reply": " ".join(reply.split())}


def ask(opening, thread, timeout=None, facts=None, behavior=None):
    """One customer message. No temperature. Opening, facts and behavior are private context."""
    model = os.environ.get("CUSTOMER_MODEL") or os.environ.get("BOT_MODEL") or "openai/gpt-5.6-sol"
    import litellm
    try:
        response = litellm.completion(
            model=model,
            messages=[
                {"role": "system", "content": prompt(opening, facts or [], behavior=behavior)},
                {"role": "user", "content": thread},
            ],
            **({"timeout": max(1, int(timeout))} if timeout else {}),
        )
        content = response.choices[0].message.content or ""
    except Exception as exc:
        return {"fault": f"The customer model call failed: {exc}"[:240]}
    from llm_hook.observe_usage import usage_of
    return {**judge(content), "usage": usage_of(response)}


def self_check():
    ok = judge('{"reply": "Requests still complete, just slowly."}')
    assert ok.get("reply", "").startswith("Requests still complete"), ok
    assert judge('{"reply": "Please mark this P0."}').get("reply") == "Please mark this P0."
    assert "fault" in judge("sure, happy to help")
    assert "fault" in judge('{"reply": "  "}')
    assert MAX_REPLIES == 5
    text = prompt("Our service is slower than normal.", ["The pool is in us-east."])
    assert "Our service is slower than normal." in text and "us-east" in text
    assert "How you write and behave" not in text
    escalate = prompt(
        "Our service is slower than normal.",
        ["The pool is in us-east."],
        behavior="escalate",
    )
    assert "frustrated" in escalate
    assert "priority codes" in escalate
    missing = prompt("Things feel off.", ["The pool is in us-east."], behavior="missing_info")
    assert "vague" in missing
    # Unknown behavior strings are treated as a freeform persona note.
    custom = prompt("Hello.", [], behavior="Stay monosyllabic.")
    assert "Stay monosyllabic." in custom
