"""Token use and dollar cost of one litellm call, and sums of them, for the run's cost report.

Used by the bot's LLM watcher (sitecustomize) and by the customer model. Cost is litellm's price for the model
(the provider's list price, cached input tokens at the cached rate); None when litellm has no price for it.
"""


def _get(obj, key):
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def usage_of(resp):
    """{"calls": 1, "in", "cached", "out", "usd"} for one completion response, or None when it carries no usage."""
    try:
        u = _get(resp, "usage")
        if u is None:
            return None
        details = _get(u, "prompt_tokens_details")
        out = {"calls": 1, "in": _get(u, "prompt_tokens") or 0, "cached": (_get(details, "cached_tokens") if details else 0) or 0,
               "out": _get(u, "completion_tokens") or 0}
        usd = (getattr(resp, "_hidden_params", None) or {}).get("response_cost")
        if usd is None:
            try:
                import litellm
                usd = litellm.completion_cost(completion_response=resp)
            except Exception:
                usd = None
        out["usd"] = round(usd, 6) if usd is not None else None
        return out
    except Exception:
        return None


def add(*parts):
    """Sum of usage dicts (single calls or earlier sums). unpriced = calls litellm could not price."""
    total = {"calls": 0, "in": 0, "cached": 0, "out": 0, "usd": 0.0, "unpriced": 0}
    for p in parts:
        if not p:
            continue
        for k in ("calls", "in", "cached", "out"):
            total[k] += p.get(k) or 0
        if "unpriced" in p:
            total["unpriced"] += p["unpriced"]
            total["usd"] += p.get("usd") or 0
        elif p.get("usd") is None:
            total["unpriced"] += p.get("calls") or 1
        else:
            total["usd"] += p["usd"]
    total["usd"] = round(total["usd"], 6)
    return total
