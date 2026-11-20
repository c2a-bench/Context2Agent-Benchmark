import type { FailureParty, Ticket } from "./types";

export function fmtQ(q: number | null | undefined): string {
  if (q == null || Number.isNaN(q)) return "—";
  return q.toFixed(2);
}

export const FAILURE_PARTIES: FailureParty[] = ["Builder", "Bot", "Harness"];

/** Type given to blame labels that name no symptom (older runs recorded no check kind). */
export const SYMPTOM_NOT_RECORDED = "wrong value (symptom not recorded)";

/** Blame label -> (party, family, type), as tests/diagnose.py failure_type does without the check. */
export const BLAME_TYPES: Record<string, [FailureParty, string, string]> = {
  "not kept": ["Builder", "Context recall", "rule never kept"],
  "not retrieved": ["Builder", "Context recall", "kept, not in context"],
  retrieval: ["Builder", "Context recall", "kept, not in context"],
  "trap doc": ["Builder", "Context precision", "wrong or stale source"],
  "chose trap doc": ["Builder", "Context precision", "wrong or stale source"],
  "stale copy": ["Builder", "Context precision", "wrong or stale source"],
  "rule buried": ["Builder", "Context precision", "rule diluted"],
  "context overflow": ["Builder", "Context precision", "context budget exceeded"],
  crashed: ["Bot", "Robustness", "crash"],
  "model call failed": ["Bot", "Robustness", "model call failed"],
  "no model call": ["Bot", "Robustness", "no model call"],
  "too slow": ["Bot", "Robustness", "time limit on every try"],
  "code decided": ["Bot", "Tool failure", "tool design gap"],
  "no tools": ["Bot", "Tool failure", "tool design gap"],
  "wrong assertion": ["Bot", "NL assertion failure", "wrong or prohibited assertion"],
  "missing assertion": ["Bot", "NL assertion failure", "missing assertion"],
  "our limit": ["Harness", "Resource limit", "time limit"],
  "our service": ["Harness", "Trace or service", "provider failure"],
  "customer fault": ["Harness", "Trace or service", "customer model failure"],
  "trace lost": ["Harness", "Trace or service", "trace lost"],
  // Fact-level blame (scripts/fact_run.py): the judge read the agent's files.
  "fact absent": ["Builder", "Context recall", "fact absent"],
  "missed customer fact": ["Bot", "Information gathering", "decisive fact not obtained"],
};

/** Which party a blame label belongs to (the grader's taxonomy); labels with no entry are the agent's tool failures. */
export function partyOf(label: string): FailureParty {
  return BLAME_TYPES[label]?.[0] ?? "Bot";
}

/** Failed tickets by party (builder / bot / harness), split evenly when a ticket's blame records name several;
 *  "none" = a failed ticket with no blame record. */
export function ticketParties(tickets: Ticket[]): Record<FailureParty | "none", number> {
  const out: Record<string, number> = { Builder: 0, Bot: 0, Harness: 0, none: 0 };
  for (const t of tickets) {
    if (t.passed) continue;
    const parties = t.blames
      ? t.blames.map((b) => (b.party === "Agent" ? "Bot" : (b.party as FailureParty | null | undefined)) ?? partyOf(b.label))
      : t.failures.map((f) => (f.fault?.taxonomy?.party === "Agent" ? "Bot" : f.fault?.taxonomy?.party) ?? (f.fault ? partyOf(f.fault.label) : null));
    const keys = [...new Set(parties.map((p) => p ?? "none"))];
    for (const k of keys.length ? keys : ["none"]) out[k] += 1 / (keys.length || 1);
  }
  return out as Record<FailureParty | "none", number>;
}

export const TYPE_LABEL: Record<string, string> = {
  "rule never kept": "Rule never saved",
  "kept, not in context": "Rule saved but never shown to the agent",
  "fact absent": "Fact missing from the agent's files",
  "wrong or stale source": "Used an outdated or look-alike page",
  "rule diluted": "Rule buried in too much text",
  "context budget exceeded": "Prompt too long",
  "wrong value": "Set a field to the wrong value",
  "wrong value (symptom not recorded)": "Wrong value (details not recorded)",
  "missing value": "Left a field empty",
  "missing label": "Missed a required label",
  "extra label or write": "Added a label or change it shouldn't",
  "forbidden action": "Took a forbidden action",
  "missing required action": "Skipped a required action",
  "protected state changed": "Changed something that had to stay untouched",
  "tool design gap": "Had no tool for it",
  "wrong or prohibited assertion": "Told the customer something wrong",
  "missing assertion": "Didn't tell the customer something required",
  "decisive fact not obtained": "Never got a key fact from the customer",
  crash: "Agent crashed",
  "model call failed": "Model call failed",
  "no model call": "Never called the model",
  "time limit": "Time limit hit",
  "our runner crashed": "Our runner crashed",
  "provider failure": "Provider failure",
  "customer model failure": "Customer model failed",
  "trace lost": "Trace lost",
};
