import { VIZ } from "@/components/charts";

// Who a failed ticket is blamed on. The grader says "Bot"; on screen it is the agent.
export const PARTY_COLOR: Record<string, string> = { Builder: VIZ[0], Bot: VIZ[2], Harness: VIZ[3] };
export const PARTY_LABEL: Record<string, string> = {
  Builder: "Builder failure",
  Bot: "Agent failure",
  Harness: "Harness failure",
  none: "No blame recorded",
};
export const PARTY_HINT: Record<string, string> = {
  Builder: "the knowledge never reached the agent",
  Bot: "the agent had the knowledge and still got it wrong",
  Harness: "our side: time limit, provider error",
};

// One colour per failure group: the builder's groups in orange tones, the agent's in purple/pink/teal, ours in yellow.
export const FAMILY_COLOR: Record<string, string> = {
  "Context recall": VIZ[0],
  "Context precision": "color-mix(in oklab, var(--viz-1) 45%, transparent)",
  "Tool failure": VIZ[2],
  "NL assertion failure": VIZ[4],
  "Information gathering": "color-mix(in oklab, var(--viz-3) 55%, transparent)",
  Robustness: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
  "Resource limit": VIZ[3],
  "Fault or crash": "color-mix(in oklab, var(--viz-4) 60%, transparent)",
  "Trace or service": "color-mix(in oklab, var(--viz-4) 35%, transparent)",
  none: "color-mix(in oklab, var(--muted-foreground) 30%, transparent)",
};
