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
