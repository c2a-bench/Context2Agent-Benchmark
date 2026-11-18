"""Fake Redwood support systems over JSON files.

Every request re-reads the JSON files, so a reset is just copying fresh files in.
Every request is appended to <data>/requests.jsonl.
"""

import argparse
import json
import os
import re
import secrets
import shutil
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

FILES = ["customers", "tickets", "api_keys", "credits", "handoffs", "requests"]

PRIORITIES = {"P0", "P1", "P2", "P3", "P4"}
FIRST_RESPONSE_TARGETS = {"15m", "30m", "1h", "2h", "4h", "1bd", "2bd", "5bd"}
ESCALATION_STATUSES = {
    "Not escalated", "Monitoring", "Eng engaged", "Incident declared", "Mitigated", "Resolved",
}
TEAMS = {
    "Support", "SRE", "Eng Platform", "Eng Infra", "Private Deployments",
    "Security", "Customer Success", "Billing Ops", "Legal",
}
STATUSES = {"New", "In Progress", "Waiting on Customer", "Resolved"}
HANDOFF_REASONS = {"not_covered", "churn_risk", "legal_threat"}
LABEL_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

DATA_DIR = Path(".")
FAIL_WRITES = 0


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def load(name):
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def save(name, value):
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(value, f, indent=2)
    os.replace(tmp, DATA_DIR / f"{name}.json")


def get_or_404(name, record_id):
    records = load(name)
    if record_id not in records:
        raise ApiError(404, f"{name[:-1]} {record_id} not found")
    return records, records[record_id]


def check_enum(body, field, allowed):
    if field in body and body[field] not in allowed:
        raise ApiError(400, f"{field} must be one of {sorted(allowed)}")


def patch_ticket(ticket_id, body):
    tickets, ticket = get_or_404("tickets", ticket_id)
    allowed = {
        "priority", "first_response_target", "escalation_status",
        "assigned_team", "needs_legal_review", "status", "labels",
    }
    unknown = set(body) - allowed
    if unknown:
        raise ApiError(400, f"unknown fields: {sorted(unknown)}")
    check_enum(body, "priority", PRIORITIES)
    check_enum(body, "first_response_target", FIRST_RESPONSE_TARGETS)
    check_enum(body, "escalation_status", ESCALATION_STATUSES)
    check_enum(body, "assigned_team", TEAMS)
    check_enum(body, "status", STATUSES)
    if "needs_legal_review" in body and not isinstance(body["needs_legal_review"], bool):
        raise ApiError(400, "needs_legal_review must be a boolean")
    if "labels" in body:
        labels = body["labels"]
        if not isinstance(labels, list) or not all(isinstance(l, str) and LABEL_RE.match(l) for l in labels):
            raise ApiError(400, "labels must be a list of lowercase strings (a-z, 0-9, -)")
        body["labels"] = sorted(set(labels))
    ticket.update(body)
    save("tickets", tickets)
    return ticket


def add_comment(ticket_id, body):
    tickets, ticket = get_or_404("tickets", ticket_id)
    if not isinstance(body.get("body"), str) or not body["body"].strip():
        raise ApiError(400, "body must be a non-empty string")
    if not isinstance(body.get("public"), bool):
        raise ApiError(400, "public must be a boolean")
    comment = {"body": body["body"], "public": body["public"]}
    ticket["comments"].append(comment)
    save("tickets", tickets)
    return comment


def disable_key(key_id):
    keys, key = get_or_404("api_keys", key_id)
    key["status"] = "disabled"
    save("api_keys", keys)
    return key


def create_credit(body):
    for field, kind in (("customer_id", str), ("amount_usd", (int, float)), ("reason", str)):
        if not isinstance(body.get(field), kind):
            raise ApiError(400, f"{field} is required")
    get_or_404("customers", body["customer_id"])
    credits = load("credits")
    credit_id = f"CR-{len(credits) + 1:04d}"
    credits[credit_id] = {k: body[k] for k in ("customer_id", "amount_usd", "reason")}
    save("credits", credits)
    return {"id": credit_id, **credits[credit_id]}


def create_handoff(body):
    if not isinstance(body.get("ticket_id"), str):
        raise ApiError(400, "ticket_id is required")
    get_or_404("tickets", body["ticket_id"])
    if body.get("reason") not in HANDOFF_REASONS:
        raise ApiError(400, f"reason must be one of {sorted(HANDOFF_REASONS)}")
    if not isinstance(body.get("summary"), str) or not body["summary"].strip():
        raise ApiError(400, "summary must be a non-empty string")
    handoffs = load("handoffs")
    handoff_id = f"H-{len(handoffs) + 1:04d}"
    handoffs[handoff_id] = {k: body[k] for k in ("ticket_id", "reason", "summary")}
    save("handoffs", handoffs)
    return {"id": handoff_id, **handoffs[handoff_id]}


def with_attempt(result):
    """Successful writes get an attempt_id in the HTTP body only. It is not stored on the record."""
    if isinstance(result, dict):
        return {**result, "attempt_id": f"att_{secrets.token_hex(4)}"}
    return result


def route(method, path, body):
    global FAIL_WRITES
    parts = [p for p in path.split("/") if p]
    if method in ("POST", "PATCH") and FAIL_WRITES > 0:
        FAIL_WRITES -= 1
        raise ApiError(500, "temporarily unavailable")
    if method == "GET" and len(parts) == 2 and parts[0] == "customers":
        return get_or_404("customers", parts[1])[1]
    if method == "GET" and len(parts) == 3 and parts[0] == "customers" and parts[2] == "api_keys":
        get_or_404("customers", parts[1])
        keys = load("api_keys")
        return [{"id": k, **v} for k, v in sorted(keys.items()) if v["customer_id"] == parts[1]]
    if method == "GET" and len(parts) == 3 and parts[0] == "customers" and parts[2] == "tickets":
        get_or_404("customers", parts[1])
        tickets = load("tickets")
        return [{"id": k, **v} for k, v in sorted(tickets.items()) if v["customer_id"] == parts[1]]
    if method == "GET" and len(parts) == 2 and parts[0] == "requests":
        return {"id": parts[1], **get_or_404("requests", parts[1])[1]}
    if method == "GET" and len(parts) == 2 and parts[0] == "tickets":
        return get_or_404("tickets", parts[1])[1]
    if method == "PATCH" and len(parts) == 2 and parts[0] == "tickets":
        return patch_ticket(parts[1], body)
    if method == "POST" and len(parts) == 3 and parts[0] == "tickets" and parts[2] == "comments":
        return add_comment(parts[1], body)
    if method == "POST" and len(parts) == 3 and parts[0] == "api_keys" and parts[2] == "disable":
        return disable_key(parts[1])
    if method == "POST" and parts == ["credits"]:
        return create_credit(body)
    if method == "POST" and parts == ["handoffs"]:
        return create_handoff(body)
    raise ApiError(404, f"no route for {method} {path}")


class Handler(BaseHTTPRequestHandler):
    def _handle(self, method):
        body = None
        status = 200
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                body = json.loads(self.rfile.read(length))
            if method in ("PATCH", "POST") and body is None:
                body = {}
            if body is not None and not isinstance(body, dict):
                raise ApiError(400, "body must be a JSON object")
            result = route(method, self.path.split("?")[0], body)
            if status == 200 and method in ("POST", "PATCH"):
                result = with_attempt(result)
        except ApiError as e:
            status, result = e.status, {"error": e.message}
        except json.JSONDecodeError:
            status, result = 400, {"error": "invalid JSON body"}
        with open(DATA_DIR / "requests.jsonl", "a") as log:
            log.write(json.dumps({
                "method": method, "path": self.path, "body": body, "status": status,
                "response": result if status < 400 else None,
                "error": result.get("error") if status >= 400 and isinstance(result, dict) else None,
            }) + "\n")
        payload = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PATCH(self):
        self._handle("PATCH")

    def log_message(self, *args):
        pass


def reset(data_dir, seed_dir):
    data_dir.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        if (seed_dir / f"{name}.json").exists():
            shutil.copyfile(seed_dir / f"{name}.json", data_dir / f"{name}.json")
        else:
            (data_dir / f"{name}.json").write_text("{}")
    (data_dir / "requests.jsonl").write_text("")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="directory holding the live JSON files")
    parser.add_argument("--reset-from", help="copy these seed files into --data before starting")
    parser.add_argument("--port", type=int, default=8700)
    parser.add_argument("--fail-writes", type=int, default=0,
                        help="return 500 on the first N POST/PATCH calls, then work as usual")
    args = parser.parse_args()

    global DATA_DIR, FAIL_WRITES
    DATA_DIR = Path(args.data)
    FAIL_WRITES = max(0, args.fail_writes)
    if args.reset_from:
        reset(DATA_DIR, Path(args.reset_from))
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
