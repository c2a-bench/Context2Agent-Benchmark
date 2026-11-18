"""The customer the support bot can talk to.

The opening and the fact list are a private note. The builder never sees them.
The customer says the opening first. It uses the list only when support asks.
It hears only what the bot puts in `reply`; nothing it says is written to the ticket.
Replay does not use this customer; the verifier puts the rule in the stdin JSON.
It does not see the company docs or the right answer. If the call fails, the
ticket is left out of the score.

Each case has one `behavior` (scripts/behavior/types.json): a persona rule such as information
exchange, correction, resistance or goal change. It never changes the facts or the right filing.
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
{policy_block}
If support asks for something not in the opening or the facts, say you don't know.
If support states a specific detail about your problem that contradicts your opening or facts (for example a different region, number, name or product), correct it in your reply. A question from support is not something to correct.
You see only what support writes to you. "Support did not reply." means support sent you nothing since your last message.
{behavior_block}
{extra_rule}
Reply with only a JSON object: {{"reply": "{reply_shape}", "corrected": false, "switched": false}}
Set "corrected" to true only when this reply corrects a specific detail support stated that contradicts your facts; fixing a mistake you made yourself does not count. Otherwise false.
Set "switched" to true only in the message where you drop an earlier, different request and move to the problem in your opening."""

LIVE_RULE = "Do not mention priority codes, team names, or ticket labels. Do not guess how the company should file the ticket."

POLICY_BLOCK = """
Company policy you must send to support, word for word:
{policy}
"""

POLICY_RULE = """When asked to send the company policy, send that policy text word for word and nothing else.
After you have sent it, you may repeat it if support asks. Do not invent a different policy.
"""

# How the customer behaves on a ticket (scripts/behavior/types.json; each ticket has one).
# Empty string = the default customer. The facts and the right filing never change.
BEHAVIOR_RULES = {
    "baseline": "",
    "on_request": "Say as little as possible. Your first message is one short sentence with no details. Share one fact per reply, and only the fact support clearly asked for.",
    "incremental": "Your first message gives one or two facts. In each later message, volunteer one or two more facts even if support did not ask for them, until you have given all of them.",
    "underspecified": "Your first message is mildly vague: it names the area but leaves out what exactly is wrong or wanted (for example \"we have an issue with our logs\"). Answer from the facts when support asks.",
    "ambiguous": "Do not copy the opening. Rewrite it vaguer, so it could mean more than one problem (for example \"something is wrong with production\" instead of \"production is down\", or \"we have a question about our logs\" instead of naming the request). Do not say which one you mean until support asks a direct question; then answer from the facts.",
    "self_correction": "In your first message, get one detail from the facts wrong (for example a number, a time, a region or a name). In your next message, correct it yourself (\"Sorry, I got that wrong: ...\") and use the right detail from then on.",
    "urgency_mismatch": "Your tone does not match the facts. If the facts describe something minor or a how-to question, sound alarmed and urgent. If they describe something serious, sound relaxed (\"no rush\"). Never change the facts themselves.",
    "pushback": "Be reluctant to cooperate. The first time support asks you for a detail, do not give it: push back or ask why they need it. Give the facts when support asks again or explains why.",
    "exception_request": "Ask support to skip a step you think is unnecessary (for example \"no need to involve another team\" or \"just do it, skip the usual checks\"). If support explains the step is required, accept it. Answer from the facts.",
    "urgency_pressure": "Stress your deadline and that this needs to be fast; repeat that it is blocking you. Answer support's questions from the facts.",
    "person_request": "Ask to speak to a person, a manager or engineering, and keep asking in later messages. Answer support's questions from the facts.",
    "frustration": "You are frustrated and impatient, and it shows: complain, say this is taking too long, sound annoyed. Still answer support's questions from the facts.",
    "goal_change": "Start with a different request: your first message asks only about this: \"{first_goal}\". In your second message, or your third at the latest, drop it (for example \"sorry, ignore that, it's fine now\") and ask about the problem in your opening instead, in your own words. From then on talk only about that problem.",
    "disfluency": "Every message, including the first, is written the way people type in a hurry: typos, filler words (um, like), run-on or broken sentences, missing punctuation and capitals. Do not copy the opening as written: retype it this way. Keep every fact accurate.",
}


# Twins send the shared opening word for word, so a behaviour that shapes the first message starts with the next one.
AFTER_OPENING = {
    "self_correction": "Your first message (the opening) is already sent. In your next message, get one detail from the facts wrong (for example a number, a time, a region or a name). In the message after that, correct it yourself (\"Sorry, I got that wrong: ...\") and use the right detail from then on.",
    "disfluency": "Your first message (the opening) is already sent. Every later message is written the way people type in a hurry: typos, filler words (um, like), run-on or broken sentences, missing punctuation and capitals. Keep every fact accurate.",
}


def behavior_block(behavior):
    rule = BEHAVIOR_RULES.get((behavior or "").strip(), "")
    if not rule and (behavior or "").strip() and (behavior or "").strip() not in BEHAVIOR_RULES:
        rule = str(behavior).strip()
    return f"How you write and behave (this comes before the rules above where they differ):\n{rule}\n" if rule else ""


def prompt(opening, facts, policy=None, behavior=None, first_goal=None):
    lines = [f"- {line}" for line in facts if str(line).strip()]
    policy = (policy or "").strip()
    return SYSTEM.format(
        opening=opening.strip(),
        facts="\n".join(lines) if lines else "- You have nothing else to add.",
        policy_block=POLICY_BLOCK.format(policy=policy) if policy else "",
        behavior_block=behavior_block(behavior).replace("{first_goal}", (first_goal or "").strip()),
        extra_rule=POLICY_RULE if policy else LIVE_RULE,
        reply_shape="your message" if policy else "one or two sentences",
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
    return {"reply": " ".join(reply.split()), "corrected": data.get("corrected") is True,
            "switched": data.get("switched") is True}


def ask(opening, thread, timeout=None, facts=None, policy=None, behavior=None, first_goal=None):
    """One customer message. No temperature. Opening, facts, optional policy/behavior are private context."""
    model = os.environ.get("CUSTOMER_MODEL") or os.environ.get("BOT_MODEL") or "openai/gpt-5.6-sol"
    import litellm
    try:
        response = litellm.completion(
            model=model,
            messages=[
                {"role": "system", "content": prompt(opening, facts or [], policy, behavior=behavior, first_goal=first_goal)},
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
    replay = prompt(
        "Our service is slower than normal.",
        ["The pool is in us-east."],
        "Company policy that applies to this ticket: Set priority P1.",
    )
    assert "Set priority P1." in replay
    assert "word for word" in replay
    for behavior, word in (("frustration", "frustrated"), ("person_request", "manager"), ("self_correction", "wrong"),
                           ("exception_request", "skip"), ("on_request", "as little"), ("urgency_mismatch", "tone")):
        text = prompt("Our service is slower than normal.", ["The pool is in us-east."], behavior=behavior)
        assert word in text and "priority codes" in text, behavior
    # Unknown behavior strings are treated as a freeform persona note.
    custom = prompt("Hello.", [], behavior="Stay monosyllabic.")
    assert "Stay monosyllabic." in custom
