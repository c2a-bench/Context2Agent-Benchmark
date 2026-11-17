// Harbor records a custom builder agent by its import path (`-a module:Class`), e.g. the Gemini CLI wrapper that turns
// its web tools off (scripts/agents/gemini_no_web.py). Show the agent it wraps instead.
const WRAPPED: Record<string, string> = {
  "gemini_no_web:GeminiCliNoWeb": "gemini-cli",
};

export function agentName(name: string | null | undefined): string {
  if (!name) return "";
  return WRAPPED[name] ?? (name.includes(":") ? name.split(":").pop()! : name);
}
