import type { Write } from "./types";

export const FIELD: Record<string, string> = {
  status: "status",
  priority: "priority",
  first_response_target: "reply target",
  assigned_team: "team",
  escalation_status: "escalation",
  labels: "labels",
  needs_legal_review: "legal review",
};

export const STATUS_LABEL = { starting: "starting rule", new: "new rule", changed: "changed", unchanged: "unchanged" } as const;

export function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "[]";
  return String(v);
}

export function lookupLabel(path: string, ticket: string, customer: string): string {
  if (path === `/customers/${customer}`) return "customer record";
  if (path === `/customers/${customer}/tickets`) return "customer's tickets";
  if (path === `/customers/${customer}/api_keys`) return "customer's API keys";
  if (path === `/tickets/${ticket}`) return "this ticket";
  const m = path.match(/^\/tickets\/(SUP-\d+)$/);
  return m ? `ticket ${m[1]}` : path;
}

export function writeLabel(w: Write, ticket: string): { title: string; detail: string } {
  const p = w.path;
  const b = (w.body ?? {}) as Record<string, unknown>;
  if (w.method === "PATCH" && p.startsWith("/tickets/"))
    return { title: p.endsWith(ticket) ? "Updated the ticket" : `Updated ${p.split("/").pop()}`, detail: Object.entries(b).map(([k, v]) => `${FIELD[k] ?? k} = ${show(v)}`).join(" · ") };
  if (p.endsWith("/comments")) return { title: b.public ? "Added a public note" : "Added an internal note", detail: String(b.body ?? "") };
  if (p.endsWith("/disable")) return { title: `Disabled API key ${p.split("/")[2]}`, detail: w.attempt ? `attempt ${w.attempt}` : "" };
  if (p === "/handoffs") return { title: "Handed the ticket to a person", detail: `${b.reason ?? ""}: ${b.summary ?? ""}` };
  if (p === "/credits") return { title: "Issued a credit", detail: JSON.stringify(b) };
  return { title: `${w.method} ${p}`, detail: "" };
}

export type FailParts = { label: string; got?: string; want?: string; plain?: string };

// Turn the verifier's failure sentence into "field: got → want".
export function failParts(line: string): FailParts {
  // The grader writes "bot"; the viewer shows its text with "agent" (data.ts reword), so both are read.
  let m = line.match(/^\s*(.+?): (?:bot|agent) set (.+?), correct is (.+)$/);
  if (m) return { label: m[1], got: m[2], want: m[3] };
  m = line.match(/^\s*(.+?): not set by the (?:bot|agent) \(correct: (.+)\)$/);
  if (m) return { label: m[1], got: "not set", want: m[2] };
  m = line.match(/^\s*(.+?): missing required (.+?) \((?:bot|agent) set (.+)\)$/);
  if (m) return { label: m[1], got: m[3], want: `+ ${m[2]}` };
  m = line.match(/^\s*Forbidden action: (.+?) \(/);
  if (m) return { label: "Not allowed", plain: m[1] };
  m = line.match(/^\s*Missing action: the (?:bot|agent) should (\S+ \S+)/);
  if (m) return { label: "Never did", want: m[1] };
  return { label: "", plain: line };
}

export const FAULT_LABEL: Record<string, string> = { bot: "Agent", builder: "Builder", us: "Us" };
export const FAULT_CLASS: Record<string, string> = {
  bot: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  builder: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  us: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
};

/** Where a ticket's answer comes from (case info_type). */
export const INFO_TYPES: Record<string, string> = {
  "1": "API only",
  "2": "customer's facts",
  "3": "API call from the customer",
  "4": "question from the API",
};

/** What the replays say a failed ticket was missing (results.json replay_verdict). */
export const REPLAY_VERDICTS: Record<string, { label: string; detail: string }> = {
  // Named by what the replays showed: which given information fixed the ticket.
  execution: { label: "Not fixed, even with rule + facts", detail: "the replay with the rule and the customer's facts both given still failed" },
  knowledge: { label: "Fixed by the rule (agent didn't have it)", detail: "the rule alone fixed it, and the rule had not reached the agent in the original run" },
  application: { label: "Fixed by the rule (agent had it)", detail: "the rule alone fixed it, though the rule had already reached the agent in the original run" },
  customer: { label: "Fixed by the facts", detail: "the customer's facts alone fixed it; the rule alone did not" },
  either: { label: "Fixed by either one alone", detail: "the rule alone fixed it, and so did the customer's facts alone" },
  both: { label: "Fixed only by rule + facts together", detail: "neither the rule alone nor the facts alone fixed it; both together did" },
  "prompt cap": { label: "Fixed once the prompt cap was lifted", detail: "it passed when the replay ran without the ticket's prompt token cap" },
  // A run graded by facts (scripts/fact_run.py): a judge read the agent's files instead of replaying.
  "prompt over cap": { label: "Builder: prompt over its size cap", detail: "the agent's files have the facts, but its prompt went over the ticket's size cap and the call was refused (context budget exceeded)" },
  "agent never started": { label: "Builder: agent never started", detail: "the agent's run program is missing or fails on start, so no ticket of the stage got an answer" },
  "fact absent": { label: "Builder: a needed fact is missing", detail: "a fact deciding a failed check is not in the agent's files" },
  "missed customer fact": { label: "Agent: did not get the customer's facts", detail: "the agent had the facts from the docs, but never got a decisive fact only the customer knows" },
  "had the facts": { label: "Agent: had the facts, got it wrong", detail: "the agent's files have every fact the failed checks need and it got the customer's facts, yet it still got the ticket wrong" },
};

/** A stage's display name: its step ("Rcomplete", "stage3" → "stage 3"). */
export function stepLabel(step: string | undefined, stage: number, capital = false) {
  const name = (step ?? `stage${stage}`).replace(/^stage(\d+)$/, `${capital ? "Stage" : "stage"} $1`);
  return name;
}
