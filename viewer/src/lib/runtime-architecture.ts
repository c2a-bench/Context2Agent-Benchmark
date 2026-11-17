import type { ArchitectureSummary, StageScore } from "./types";

export type ArchRow = {
  stage: number;
  step: string;
  qPassed: number | null;
  qTotal: number | null;
  qPct: number | null;
  reward: number | null;
  architectureChoice: string;
  archClass: ArchClass | null;
  /** Set when the run has no runtime trace, so embedding calls (Retrieval) could not be seen. */
  archClassNote: string | null;
  stated: Record<string, number | boolean | string>;
  observed: Record<string, number | string>;
  selfRight: number | null;
  selfChecked: number | null;
  subsetRules: number | null;
  subsetKept: number | null;
  subsetReached: number | null;
  claimsOk: number;
  claimsTotal: number;
  claims: { claim: string; ok: boolean; said: string; saw: string }[];
  raw: ArchitectureSummary;
};

export type ArchClass = string;

export const KNOWLEDGE_ACCESS_LABELS: Record<string, string> = {
  llm_wiki: "LLM wiki",
  sparse_retrieval: "Sparse retrieval",
  dense_retrieval: "Dense retrieval",
  knowledge_graph: "Knowledge graph",
};
const KNOWLEDGE_ACCESS_ORDER = ["llm_wiki", "sparse_retrieval", "dense_retrieval", "knowledge_graph"];

/** RQ3 class from the observed knowledge_access categories (multi-select), e.g. "LLM wiki + Sparse retrieval". */
export function knowledgeAccessClass(cats: string[]): string {
  if (!cats.length) return "No wiki or retrieval";
  return [...cats]
    .sort((a, b) => KNOWLEDGE_ACCESS_ORDER.indexOf(a) - KNOWLEDGE_ACCESS_ORDER.indexOf(b))
    .map((c) => KNOWLEDGE_ACCESS_LABELS[c] ?? c)
    .join(" + ");
}

/** RQ3 class from observed traces, first match wins: retrieval, multi-prompt, tool loop, single call. */
export function archClassOf(obs: ArchitectureSummary["observed"] | undefined): ArchClass | null {
  if (!obs) return null;
  // Runs graded with knowledge_access: the class is that category set.
  if (Array.isArray(obs.knowledge_access)) return knowledgeAccessClass(obs.knowledge_access);
  const known =
    obs.embedding_calls != null || obs.max_system_prompts_in_one_ticket != null || !!obs.tools_offered?.length;
  if (!known) return null;
  if (obs.traced !== false && (obs.embedding_calls ?? 0) > 0) return "Retrieval";
  // No runtime trace: fall back to whether the agent's code calls embeddings.
  if (obs.traced === false && obs.embeddings_in_code?.length) return "Retrieval";
  if ((obs.max_system_prompts_in_one_ticket ?? 0) > 1) return "Multi-prompt";
  if ((obs.tools_offered?.length ?? 0) > 0) return "Tool loop";
  return "Single call";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function show(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.join(", ") || "—";
  return String(v);
}

export function architectureForStage(stage: number, score: StageScore | undefined): ArchRow {
  const a = score?.architecture ?? {};
  const q = a.q ?? {};
  const qPassed = num(q.passed) ?? num(score?.passed);
  const qTotal = num(q.total) ?? num(score?.total);
  const stated: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(a.stated ?? {})) {
    if (v == null) continue;
    if (Array.isArray(v)) stated[k] = v.join(", ");
    else if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") stated[k] = v;
  }
  const obs = a.observed ?? {};
  const observed: Record<string, number | string> = {};
  const obsKeys: (keyof NonNullable<ArchitectureSummary["observed"]>)[] = [
    "model_calls_avg",
    "model_calls_max",
    "model_calls_per_run_avg",
    "model_calls_per_run_max",
    "n_tools_offered",
    "embedding_calls",
    "max_system_prompts_in_one_ticket",
    "n_bot_data_files_read",
    "n_files_written",
    "n_extra_libraries",
    "handoffs_made",
  ];
  const traceOnly = new Set(["embedding_calls", "n_bot_data_files_read", "n_files_written", "n_extra_libraries"]);
  for (const k of obsKeys) {
    const v = obs[k];
    if (obs.traced === false && traceOnly.has(k)) continue;
    if (typeof v === "number") observed[k] = v;
  }
  if (obs.tools_offered?.length) observed.tools_offered = obs.tools_offered.join(", ");
  if (obs.extra_libraries?.length) observed.extra_libraries = obs.extra_libraries.join(", ");

  const claims = (a.claims ?? [])
    .filter((c) => c.claim)
    .map((c) => ({
      claim: String(c.claim),
      ok: !!c.ok,
      said: show(c.said),
      saw: show(c.saw),
    }));

  return {
    stage,
    step: score?.step ?? `stage${stage}`,
    qPassed,
    qTotal,
    qPct: qPassed != null && qTotal ? (100 * qPassed) / qTotal : null,
    reward: num(q.reward) ?? num(score?.reward),
    architectureChoice: a.design?.architecture_choice ?? "—",
    archClass: archClassOf(a.observed),
    archClassNote: Array.isArray(a.observed?.knowledge_access)
      ? Object.entries(a.observed?.knowledge_access_evidence ?? {})
          .map(([k, v]) => `${KNOWLEDGE_ACCESS_LABELS[k] ?? k}: ${v === "trace" ? "seen at runtime" : "in the agent's code"}`)
          .join(" · ") || null
      : a.observed?.traced === false
        ? a.observed.embeddings_in_code?.length
          ? `no runtime trace: class from the agent's code (${a.observed.embeddings_in_code.join(", ")} calls embeddings)`
          : "no runtime trace: class from the agent's code (no embedding calls in it)"
        : null,
    stated,
    observed,
    selfRight: num(a.self_report?.right),
    selfChecked: num(a.self_report?.checked),
    subsetRules: num(a.subset?.rules),
    subsetKept: num(a.subset?.kept),
    subsetReached: num(a.subset?.reached),
    claimsOk: claims.filter((c) => c.ok).length,
    claimsTotal: claims.length,
    claims,
    raw: a,
  };
}

export function fmtQ(passed: number | null, total: number | null, pct: number | null): string {
  if (passed == null || total == null || !total) return "—";
  return `${passed}/${total}${pct != null ? ` (${pct.toFixed(1)}%)` : ""}`;
}

export function fmtNum(v: number | boolean | string | null | undefined): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export const STATED_COLS = [
  "n_tools",
  "n_prompt_files",
  "n_skills",
  "n_extra_libraries",
  "max_model_calls_per_ticket",
  "human_handoff",
  "writes_files_at_runtime",
] as const;

export const OBSERVED_COLS = [
  "model_calls_avg",
  "model_calls_max",
  "model_calls_per_run_avg",
  "model_calls_per_run_max",
  "n_tools_offered",
  "embedding_calls",
  "n_bot_data_files_read",
  "handoffs_made",
  "n_files_written",
  "n_extra_libraries",
] as const;

export function presentCols(rows: ArchRow[], keys: readonly string[], bag: "stated" | "observed"): string[] {
  return keys.filter((k) => rows.some((r) => r[bag][k] != null && r[bag][k] !== ""));
}
