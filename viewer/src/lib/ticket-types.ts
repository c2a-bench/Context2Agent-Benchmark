import type { StageScore } from "./types";

/** Ticket types against earlier stages (scripts/build_facts.py), in display order. They add up to every ticket. */
export const TICKET_TYPES = ["discovery", "regression", "adaptability"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** Plain names first, the technical term in parentheses. */
export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  discovery: "New tickets, new facts (discovery)",
  regression: "Old tickets, old facts (regression)",
  adaptability: "Old tickets, new facts (adaptability)",
};

export const TICKET_TYPE_DEFS: Record<TicketType, string> = {
  discovery: "New task, new pass condition: a ticket no earlier stage had. Measures whether the agent handles what it has not seen.",
  regression: "Old task, old pass condition: an earlier stage's ticket whose expected answer did not change. Measures whether the agent kept what it got right.",
  adaptability: "Old task, new pass condition: an earlier stage's ticket whose expected answer changed with the docs. Measures whether the agent adapted to the change.",
};

export type TypeScore = { passed: number; total: number };

/** A stage's tickets by type; null when the run's data has no types (support-agent-knowledge, or data built before). */
export function ticketTypes(score: StageScore | undefined): Record<TicketType, TypeScore> | null {
  const t = score?.ticket_types;
  if (!t) return null;
  return Object.fromEntries(TICKET_TYPES.map((k) => [k, t[k] ?? { passed: 0, total: 0 }])) as Record<TicketType, TypeScore>;
}
