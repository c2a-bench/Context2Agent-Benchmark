/** Shared run addressing + catalog types (safe for Node scripts and the Next app). */

export const DEFAULT_TASK = "redwood-inference";

/** Task folders were renamed; old run links still open. */
export const OLD_NAMES: Record<string, string> = {
  "support-agent-customer": "redwood-inference",
  "support-agent-sourcegraph": "sourcegraph",
  "support-agent-beacon-observability": "meridian-telemetry",
};

/** A run is addressed as "<task>.<job>" (for example sourcegraph.2026-10-05__10-20-04).
 *  A bare job id means the default task, so older links keep working. */
export function runKey(task: string, job: string) {
  return `${task}.${job}`;
}

export function parseRunKey(key: string): { task: string; job: string } {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`bad run ${key}`);
  const dot = key.indexOf(".");
  const named = dot > 0 ? key.slice(0, dot) : DEFAULT_TASK;
  const task = OLD_NAMES[named] ?? named;
  const job = dot > 0 ? key.slice(dot + 1) : key;
  return { task, job };
}

export type TaskSummary = {
  id: string;
  name: string;
  description: string;
  runs: number;
  latest: string | null;
  sources: { label: string; url: string }[];
};

/** Who decided the saved changes in one stage (scores.json change_sources). */
export type ChangeSourceSummary = {
  model: number;
  text: number;
  code: number;
  total: number;
  code_decided: { ticket: string; call: string; field: string; value: unknown }[];
};

export type JobSummary = {
  key: string;
  id: string;
  started: string | null;
  finished: boolean;
  /** Only in catalogs written before build and run durations were dropped; nothing reads them. */
  minutes?: number | null;
  buildMinutes?: number[];
  /** The builder's thinking setting from its logs: Codex reasoning_effort ("default" when unset), Claude Code effort. */
  thinking?: string | null;
  /** skyway-arch: the architecture the run was given (the name of its file in tasks/skyway-arch/architectures). */
  architecture?: string | null;
  /** Published runs: when the run was last uploaded (its files' version in their addresses). */
  publishedAt?: string;
  score: number | null;
  builder: { agent: string | null; model: string | null };
  bot: string | null;
  cost: number | null;
  tokens: { input: number | null; cached: number | null; output: number | null };
  scores: {
    stage: number;
    passed?: number;
    total?: number;
    ours?: number;
    by_group?: Record<string, { passed: number; total: number }>;
    behavior_coverage?: {
      mode?: "per_ticket";
      q_coverage: number;
      n_scenarios: number;
      n_behaviors?: number;
      by_category?: Record<string, { scenarios: number; passed: number; total: number; q: number }>;
    };
    realization_robustness?: {
      mean_q_realization: number | null;
      n_multi_realization_scenarios: number;
    };
    change_sources?: ChangeSourceSummary;
  }[];
};

/** Catalog stored at <prefix>/index.json on Blob. */
export type PublishedIndex = {
  updatedAt: string;
  prefix: string;
  tasks: {
    id: string;
    name: string;
    description: string;
    sources: { label: string; url: string }[];
    jobs: JobSummary[];
  }[];
};

export const JOB_FILES = ["meta.json", "tickets.json", "code.json", "docs.json"] as const;
