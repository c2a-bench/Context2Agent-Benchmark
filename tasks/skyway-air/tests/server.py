"""Fake Skyway Air support systems over JSON files.

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
from urllib.parse import parse_qs, urlsplit
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

FILES = ["customers", "bookings", "flights", "bag_reports", "tickets", "refunds", "credits", "reimbursements",
         "approvals", "changes", "handoffs"]

CATEGORIES = {"refund", "disruption", "baggage", "change", "service", "other"}
STATUSES = {"open", "pending", "resolved"}
REFUND_METHODS = {"original_payment"}
CREDIT_REASONS = {"cancellation", "voluntary_cancellation", "compensation", "goodwill", "fare_difference", "assistance"}
REIMBURSEMENT_KINDS = {"hotel", "meals", "transport", "bag_expenses", "bag_repair"}
APPROVAL_KINDS = {"hotel", "goodwill"}
HANDOFF_REASONS = {"safety", "legal", "conduct", "not_covered"}
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
        raise ApiError(404, f"{name.rstrip('s').replace('_', ' ')} {record_id} not found")
    return records, records[record_id]


def need(body, field, kind, allowed=None):
    if not isinstance(body.get(field), kind) or isinstance(body.get(field), bool) and kind is not bool:
        raise ApiError(400, f"{field} is required")
    if allowed is not None and body[field] not in allowed:
        raise ApiError(400, f"{field} must be one of {sorted(allowed)}")
    return body[field]


def amount_of(body):
    amount = need(body, "amount", (int, float))
    if amount <= 0:
        raise ApiError(400, "amount must be positive")
    return round(amount, 2)


def patch_ticket(ticket_id, body):
    tickets, ticket = get_or_404("tickets", ticket_id)
    unknown = set(body) - {"category", "labels", "status", "booking_id"}
    if unknown:
        raise ApiError(400, f"unknown fields: {sorted(unknown)}")
    if "category" in body and body["category"] not in CATEGORIES:
        raise ApiError(400, f"category must be one of {sorted(CATEGORIES)}")
    if "status" in body and body["status"] not in STATUSES:
        raise ApiError(400, f"status must be one of {sorted(STATUSES)}")
    if "booking_id" in body and body["booking_id"] is not None and body["booking_id"] not in load("bookings"):
        raise ApiError(400, f"booking {body['booking_id']} not found")
    if "labels" in body:
        labels = body["labels"]
        if not isinstance(labels, list) or not all(isinstance(l, str) and LABEL_RE.match(l) for l in labels):
            raise ApiError(400, "labels must be a list of lowercase strings (a-z, 0-9, -)")
        body["labels"] = sorted(set(labels))
    ticket.update(body)
    save("tickets", tickets)
    return {"id": ticket_id, **ticket}


def add_comment(ticket_id, body):
    tickets, ticket = get_or_404("tickets", ticket_id)
    if not isinstance(body.get("body"), str) or not body["body"].strip():
        raise ApiError(400, "body must be a non-empty string")
    if not isinstance(body.get("public"), bool):
        raise ApiError(400, "public must be a boolean")
    comment = {"body": body["body"], "public": body["public"]}
    ticket.setdefault("comments", []).append(comment)
    save("tickets", tickets)
    return comment


def booking_of(body):
    booking_id = need(body, "booking_id", str)
    get_or_404("bookings", booking_id)
    return booking_id


def create_refund(body):
    """Refunds add up per booking, so a second refund for the same booking is visible."""
    booking_id = booking_of(body)
    amount = amount_of(body)
    method = need(body, "method", str, REFUND_METHODS)
    refunds = load("refunds")
    rec = refunds.setdefault(booking_id, {"amount": 0, "method": method})
    rec["amount"] = round(rec["amount"] + amount, 2)
    rec["method"] = method
    save("refunds", refunds)
    return {"booking_id": booking_id, "amount": amount, "method": method}


def create_credit(body):
    """Travel credit per booking and reason: credits.<booking>.<reason> is the total for that reason."""
    booking_id = booking_of(body)
    amount = amount_of(body)
    reason = need(body, "reason", str, CREDIT_REASONS)
    credits = load("credits")
    rec = credits.setdefault(booking_id, {})
    rec[reason] = round(rec.get(reason, 0) + amount, 2)
    save("credits", credits)
    return {"booking_id": booking_id, "amount": amount, "reason": reason}


def create_reimbursement(body):
    booking_id = booking_of(body)
    amount = amount_of(body)
    kind = need(body, "kind", str, REIMBURSEMENT_KINDS)
    reimbursements = load("reimbursements")
    rec = reimbursements.setdefault(booking_id, {})
    rec[kind] = round(rec.get(kind, 0) + amount, 2)
    save("reimbursements", reimbursements)
    return {"booking_id": booking_id, "amount": amount, "kind": kind}


def create_approval(body):
    """A supervisor approval request, one per ticket. Nothing is paid until a supervisor approves."""
    ticket_id = need(body, "ticket_id", str)
    get_or_404("tickets", ticket_id)
    booking_id = booking_of(body)
    kind = need(body, "kind", str, APPROVAL_KINDS)
    amount = amount_of(body)
    approvals = load("approvals")
    if ticket_id in approvals:
        raise ApiError(409, f"ticket {ticket_id} already has an approval request")
    approvals[ticket_id] = {"booking_id": booking_id, "kind": kind, "amount": amount, "status": "pending"}
    save("approvals", approvals)
    return {"ticket_id": ticket_id, **approvals[ticket_id]}


def change_booking(booking_id, body):
    get_or_404("bookings", booking_id)
    to_flight = need(body, "to_flight", str)
    get_or_404("flights", to_flight)
    fee = need(body, "change_fee", (int, float))
    diff = need(body, "fare_difference", (int, float))
    if fee < 0 or diff < 0:
        raise ApiError(400, "change_fee and fare_difference cannot be negative")
    changes = load("changes")
    changes[booking_id] = {"to_flight": to_flight, "change_fee": round(fee, 2), "fare_difference": round(diff, 2)}
    save("changes", changes)
    return {"booking_id": booking_id, **changes[booking_id]}


def create_handoff(body):
    ticket_id = need(body, "ticket_id", str)
    get_or_404("tickets", ticket_id)
    reason = need(body, "reason", str, HANDOFF_REASONS)
    if not isinstance(body.get("summary"), str) or not body["summary"].strip():
        raise ApiError(400, "summary must be a non-empty string")
    handoffs = load("handoffs")
    handoff_id = f"H-{len(handoffs) + 1:04d}"
    handoffs[handoff_id] = {"ticket_id": ticket_id, "reason": reason, "summary": body["summary"]}
    save("handoffs", handoffs)
    return {"id": handoff_id, **handoffs[handoff_id]}


CONFIRMED = ("/refunds", "/credits", "/reimbursements")


def with_confirmation(path, result):
    """Successful payments get a confirmation_id in the HTTP body only. It is not stored on the record."""
    if path.rstrip("/") in CONFIRMED and isinstance(result, dict):
        return {**result, "confirmation_id": f"cf_{secrets.token_hex(4)}"}
    return result


def per_booking(name, booking_id):
    get_or_404("bookings", booking_id)
    return load(name).get(booking_id, {})


def route(method, path, body, query=None):
    global FAIL_WRITES
    query = query or {}
    parts = [p for p in path.split("/") if p]
    if method in ("POST", "PATCH") and FAIL_WRITES > 0:
        FAIL_WRITES -= 1
        raise ApiError(500, "temporarily unavailable")
    if method == "GET":
        if len(parts) == 2 and parts[0] in ("customers", "bookings", "flights", "bag_reports", "tickets"):
            return {"id": parts[1], **get_or_404(parts[0], parts[1])[1]}
        if len(parts) == 3 and parts[0] == "customers" and parts[2] in ("bookings", "tickets"):
            get_or_404("customers", parts[1])
            records = load(parts[2])
            return [{"id": k, **v} for k, v in sorted(records.items()) if v.get("customer_id") == parts[1]]
        if parts == ["flights"]:  # search: ?route=BNA-PHX&date=2026-06-07, earliest first
            route = (query.get("route") or [None])[0]
            day = (query.get("date") or [None])[0]
            if not route:
                raise ApiError(400, "route is required, e.g. ?route=BNA-PHX")
            found = [{"id": k, **v} for k, v in load("flights").items()
                     if v.get("route") == route and day in (None, str(v.get("scheduled_departure"))[:10])]
            return sorted(found, key=lambda f: f["scheduled_departure"])
        if parts == ["bag_reports"]:
            tag = (query.get("tag_number") or [None])[0]
            booking = (query.get("booking_id") or [None])[0]
            return [{"id": k, **v} for k, v in sorted(load("bag_reports").items())
                    if tag in (None, v.get("tag_number")) and booking in (None, v.get("booking_id"))]
        if len(parts) == 2 and parts[0] in ("refunds", "credits", "reimbursements", "changes"):
            return per_booking(parts[0], parts[1])
        if parts == ["approvals"]:
            booking = (query.get("booking_id") or [None])[0]
            return [{"ticket_id": k, **v} for k, v in sorted(load("approvals").items()) if booking in (None, v.get("booking_id"))]
    if method == "PATCH" and len(parts) == 2 and parts[0] == "tickets":
        return patch_ticket(parts[1], body)
    if method == "POST":
        if len(parts) == 3 and parts[0] == "tickets" and parts[2] == "comments":
            return add_comment(parts[1], body)
        if len(parts) == 3 and parts[0] == "bookings" and parts[2] == "change":
            return change_booking(parts[1], body)
        handlers = {"refunds": create_refund, "credits": create_credit, "reimbursements": create_reimbursement,
                    "approvals": create_approval, "handoffs": create_handoff}
        if len(parts) == 1 and parts[0] in handlers:
            return handlers[parts[0]](body)
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
            url = urlsplit(self.path)
            result = route(method, url.path, body, parse_qs(url.query))
            if method == "POST":
                result = with_confirmation(url.path, result)
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
