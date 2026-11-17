import { VIZ } from "@/components/charts";

// Replay verdicts in stacking order (bottom first), one colour each on every page: orange = fixed by the rule (bot
// didn't have it), teal = fixed by the rule (agent had it), magenta = not fixed. Checked for colour-blind separation.
export const VERDICT_COLOR: Record<string, string> = {
  knowledge: VIZ[0],
  application: VIZ[1],
  customer: VIZ[2],
  execution: VIZ[4],
  either: VIZ[3],
  both: "color-mix(in oklab, var(--muted-foreground) 64%, transparent)",
  "prompt cap": "color-mix(in oklab, var(--muted-foreground) 32%, transparent)",
  // Fact-graded runs: builder verdicts in the builder's orange family, agent verdicts in the agent's.
  "prompt over cap": "color-mix(in oklab, var(--viz-1) 30%, transparent)",
  "agent never started": "color-mix(in oklab, var(--viz-1) 60%, transparent)",
  "fact absent": VIZ[0],
  "missed customer fact": "color-mix(in oklab, var(--viz-3) 55%, transparent)",
  "had the facts": VIZ[2],
};
export const VERDICT_ORDER = Object.keys(VERDICT_COLOR);
