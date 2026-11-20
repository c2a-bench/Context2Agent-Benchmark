import type {
  BehaviorAttributionScore,
  PerTicketAttributionCounts,
  PerTicketAttributionScore,
  StageScore,
} from "./types";

/** Verifier behavior_coverage block (RQ7). mode "per_ticket": by_category is keyed by behavior subcategory. */
export type BehaviorCoverage = {
  mode?: "per_ticket";
  q_coverage: number;
  weights?: string;
  n_scenarios: number;
  n_behaviors?: number;
  by_category?: Record<
    string,
    { scenarios: number; passed: number; total: number; q: number }
  >;
  /** per_ticket only: passed/total per behavior family. Absent on older runs. */
  by_family?: Record<string, { passed: number; total: number; q: number }>;
  by_scenario?: {
    scenario: string;
    category: string;
    q: number;
    passed: number;
    total: number;
  }[];
};

/** Verifier realization_robustness block (RQ7). */
export type RealizationRobustness = {
  mean_q_realization: number | null;
  n_multi_realization_scenarios: number;
  by_scenario?: {
    scenario: string;
    category: string;
    q_realization: number;
    n_realizations: number;
    realizations?: { id: string; realization: string; behavior?: string; passed: boolean }[];
  }[];
};

export type BehaviorStage = {
  stage: number;
  headline: { passed: number; total: number; empty?: boolean };
  coverage: BehaviorCoverage | null;
  realization: RealizationRobustness | null;
  /** Old scenario format only (control vs variants). */
  attribution: BehaviorAttributionScore | null;
  /** One behavior per ticket (no scenarios): coverage.by_category is keyed by behavior. */
  perTicket: boolean;
  /** Per-ticket format only: failed tickets per behavior, split by the replay with the rule stated. */
  ticketAttribution: PerTicketAttributionScore | null;
  /** True when this stage has behavior scenarios or behavior-tagged tickets (RQ7). */
  answersRq: boolean;
};

/** stage value of the row that combines every stage. */
export const ALL_STAGES = -1;

export const CATEGORY_LABELS: Record<string, string> = {
  normal: "Normal (incl. wording variants)",
  missing_info: "Missing info",
  ambiguous: "Ambiguous",
  conflict: "Conflicting",
  escalate: "Escalation",
  exception: "Exception",
  boundary: "Boundary",
  linguistic: "Linguistic",
  handoff: "Handoff",
};

export const CATEGORY_ORDER = [
  "normal",
  "missing_info",
  "ambiguous",
  "conflict",
  "escalate",
  "exception",
  "boundary",
  "linguistic",
];

/** Per-ticket format: one customer behavior subcategory per ticket (scripts/behavior/types.json). */
export const BEHAVIORS: Record<string, { label: string; family: string }> = {
  baseline: { label: "Plain customer", family: "Baseline" },
  on_request: { label: "On request", family: "Information exchange" },
  incremental: { label: "Incremental", family: "Information exchange" },
  underspecified: { label: "Underspecified", family: "Ambiguity" },
  ambiguous: { label: "Ambiguous", family: "Ambiguity" },
  self_correction: { label: "Self-correction", family: "Correction" },
  urgency_mismatch: { label: "Urgency mismatch", family: "Framing conflict" },
  pushback: { label: "Pushback", family: "Resistance" },
  exception_request: { label: "Exception request", family: "Resistance" },
  urgency_pressure: { label: "Urgency pressure", family: "Escalation" },
  person_request: { label: "Person request", family: "Escalation" },
  frustration: { label: "Frustration", family: "Frustration" },
  goal_change: { label: "Goal change", family: "Goal change" },
  disfluency: { label: "Disfluency", family: "Linguistic form" },
};

export const BEHAVIOR_ORDER = Object.keys(BEHAVIORS);

/** How a group is shown: the plain customer's group is "Baseline" in the data (the grader's by_family keys). */
export function familyLabel(f: string): string {
  return f === "Baseline" ? "Plain customer" : f;
}

export const FAMILY_ORDER = [...new Set(Object.values(BEHAVIORS).map((b) => b.family))];

/** The no-behavior control ticket. */
export const BASELINE = "baseline";

/** Baseline key of a by_category record: "normal" on runs graded with the earlier behavior list. */
export function baselineKey(keys: string[]): string | null {
  return keys.includes(BASELINE) ? BASELINE : keys.includes("normal") ? "normal" : null;
}

export function behaviorLabel(b: string): string {
  return BEHAVIORS[b]?.label ?? b;
}

/** Family of a subcategory; unknown keys (e.g. runs graded with an older list) are their own family. */
export function behaviorFamily(b: string): string {
  return BEHAVIORS[b]?.family ?? b;
}

/** Known behaviors first, in BEHAVIOR_ORDER (an older "normal" with baseline), then any others alphabetically. */
export function sortBehaviors(keys: string[]): string[] {
  const rank = (k: string) =>
    k === "normal" ? 0 : BEHAVIOR_ORDER.includes(k) ? BEHAVIOR_ORDER.indexOf(k) : BEHAVIOR_ORDER.length;
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function sortFamilies(keys: string[]): string[] {
  const rank = (k: string) => (FAMILY_ORDER.includes(k) ? FAMILY_ORDER.indexOf(k) : FAMILY_ORDER.length);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export type FamilyRates = Record<string, { passed: number; total: number; q: number }>;

/** Pass rate per family: the grader's by_family when present, else summed from by_category. */
export function familyRates(coverage: BehaviorCoverage | null | undefined): FamilyRates {
  const raw = coverage?.by_family;
  const sums: FamilyRates = {};
  if (raw && Object.keys(raw).length) {
    for (const [f, v] of Object.entries(raw)) sums[f] = { passed: v.passed, total: v.total, q: 0 };
  } else {
    for (const [b, v] of Object.entries(coverage?.by_category ?? {})) {
      const row = (sums[behaviorFamily(b)] ??= { passed: 0, total: 0, q: 0 });
      row.passed += v.passed;
      row.total += v.total;
    }
  }
  const out: FamilyRates = {};
  for (const f of sortFamilies(Object.keys(sums))) {
    const row = sums[f];
    out[f] = { ...row, q: row.total ? row.passed / row.total : (raw?.[f]?.q ?? 0) };
  }
  return out;
}

export const RESEARCH_QUESTION =
  "When the docs stay fixed, does the agent still file correctly across different customer behaviors?";

export function behaviorForStage(stage: number, score: StageScore | undefined): BehaviorStage {
  const coverage = score?.behavior_coverage ?? null;
  const realization = score?.realization_robustness ?? null;
  const rawAttribution = score?.behavior_attribution ?? null;
  const perTicket = coverage?.mode === "per_ticket";
  const ticketAttribution = rawAttribution?.mode === "per_ticket" ? rawAttribution : null;
  const attribution = rawAttribution && rawAttribution.mode !== "per_ticket" ? rawAttribution : null;
  const answersRq = !!(
    coverage &&
    (perTicket ? Object.keys(coverage.by_category ?? {}).length > 0 : coverage.n_scenarios > 0)
  );
  return {
    stage,
    headline: {
      passed: score?.passed ?? 0,
      total: score?.total ?? 0,
      empty: !score?.total,
    },
    coverage,
    realization: perTicket ? null : realization,
    attribution,
    perTicket,
    ticketAttribution,
    answersRq,
  };
}

export function fmtQ(q: number | null | undefined): string {
  if (q == null || Number.isNaN(q)) return "—";
  return q.toFixed(2);
}

export function fmtPct(q: number | null | undefined): string {
  if (q == null || Number.isNaN(q)) return "—";
  return `${Math.round(100 * q)}%`;
}

export function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat;
}

export const ATTRIBUTION_KINDS = [
  "behavior_failures",
  "doc_failures",
  "no_control",
  "ours",
  "bot_errors",
] as const;

export const ATTRIBUTION_LABELS: Record<(typeof ATTRIBUTION_KINDS)[number], string> = {
  behavior_failures: "behavior failure",
  doc_failures: "doc failure",
  no_control: "control did not run",
  ours: "ours",
  bot_errors: "agent error",
};

function combineByBehavior(list: BehaviorAttributionScore[]): BehaviorAttributionScore["by_behavior"] {
  const out: NonNullable<BehaviorAttributionScore["by_behavior"]> = {};
  for (const a of list) {
    for (const [k, v] of Object.entries(a.by_behavior ?? {})) {
      const row = (out[k] ??= { tickets: 0, behavior_failures: 0, doc_failures: 0, ours: 0, bot_errors: 0, no_control: 0 });
      row.tickets += v.tickets;
      row.behavior_failures += v.behavior_failures;
      row.doc_failures += v.doc_failures;
      row.ours = (row.ours ?? 0) + (v.ours ?? 0);
      row.bot_errors = (row.bot_errors ?? 0) + (v.bot_errors ?? 0);
      row.no_control = (row.no_control ?? 0) + (v.no_control ?? 0);
    }
  }
  return out;
}

export const TICKET_ATTRIBUTION_KINDS = [
  "failed",
  "lacked_rule",
  "fixed_when_told",
  "cannot_apply",
  "execution",
  "ours",
  "bot_errors",
] as const;

export const TICKET_ATTRIBUTION_LABELS: Record<(typeof TICKET_ATTRIBUTION_KINDS)[number], string> = {
  failed: "failed",
  lacked_rule: "Fixed by the rule (agent didn't have it)",
  fixed_when_told: "Fixed by the rule (agent had it)",
  cannot_apply: "Rule alone didn't fix it",
  execution: "Not fixed, even with rule + facts",
  ours: "ours",
  bot_errors: "agent errors",
};

const COUNT_KEYS = [
  "tickets",
  "failed",
  "ours",
  "bot_errors",
  "lacked_rule",
  "fixed_when_told",
  "cannot_apply",
  "execution",
  "not_replayed",
  "plain_replayed",
  "plain_passed",
] as const;

function emptyCounts(): PerTicketAttributionCounts {
  return { tickets: 0, failed: 0, ours: 0, bot_errors: 0, lacked_rule: 0, fixed_when_told: 0, cannot_apply: 0, execution: 0, not_replayed: 0, plain_replayed: 0, plain_passed: 0 };
}

function addCounts(into: PerTicketAttributionCounts, v: Partial<PerTicketAttributionCounts>) {
  for (const k of COUNT_KEYS) into[k] += v[k] ?? 0;
}

/** Per-ticket format over several stages: passed/total summed per behavior, q = passed/total,
 *  Qcoverage = mean of the per-behavior q (each behavior weighs the same); attribution counts summed. */
function combinePerTicketStages(hits: BehaviorStage[]): BehaviorStage {
  const byCategory: NonNullable<BehaviorCoverage["by_category"]> = {};
  for (const r of hits) {
    for (const [b, v] of Object.entries(r.coverage?.by_category ?? {})) {
      const row = (byCategory[b] ??= { scenarios: 0, passed: 0, total: 0, q: 0 });
      row.passed += v.passed;
      row.total += v.total;
      row.scenarios += v.total;
    }
  }
  const ordered: typeof byCategory = {};
  for (const b of sortBehaviors(Object.keys(byCategory))) {
    const row = byCategory[b];
    row.q = row.total ? row.passed / row.total : 0;
    ordered[b] = row;
  }
  const qs = Object.values(ordered).map((r) => r.q);
  const byFamily: FamilyRates = {};
  for (const r of hits) {
    for (const [f, v] of Object.entries(familyRates(r.coverage))) {
      const row = (byFamily[f] ??= { passed: 0, total: 0, q: 0 });
      row.passed += v.passed;
      row.total += v.total;
    }
  }
  for (const row of Object.values(byFamily)) row.q = row.total ? row.passed / row.total : 0;
  const attrs = hits.map((r) => r.ticketAttribution).filter((a): a is PerTicketAttributionScore => !!a);
  let ticketAttribution: PerTicketAttributionScore | null = null;
  if (attrs.length) {
    const total = emptyCounts();
    const by: Record<string, PerTicketAttributionCounts> = {};
    for (const a of attrs) {
      addCounts(total, a);
      for (const [b, v] of Object.entries(a.by_behavior ?? {})) addCounts((by[b] ??= emptyCounts()), v);
    }
    const byOrdered: typeof by = {};
    for (const b of sortBehaviors(Object.keys(by))) byOrdered[b] = by[b];
    ticketAttribution = { mode: "per_ticket", ...total, by_behavior: byOrdered };
  }
  const cats = Object.values(ordered);
  return {
    stage: ALL_STAGES,
    headline: {
      passed: cats.reduce((n, c) => n + c.passed, 0),
      total: cats.reduce((n, c) => n + c.total, 0),
    },
    coverage: {
      mode: "per_ticket",
      q_coverage: qs.length ? qs.reduce((n, q) => n + q, 0) / qs.length : 0,
      weights: "uniform_behavior",
      n_scenarios: 0,
      n_behaviors: qs.length,
      by_category: ordered,
      // Without the grader's by_family, the page sums families from the combined by_category.
      by_family: hits.some((r) => r.coverage?.by_family)
        ? familyRates({ q_coverage: 0, n_scenarios: 0, by_family: byFamily })
        : undefined,
      by_scenario: [],
    },
    realization: null,
    attribution: null,
    perTicket: true,
    ticketAttribution,
    answersRq: true,
  };
}

/** RQ7 over every stage: each stage holds one behavior scenario, so no single stage is the answer.
 *  Qcoverage is the uniform mean over all (scenario, category) cells; counts are summed. */
export function combineBehaviorStages(rows: BehaviorStage[]): BehaviorStage | null {
  const hits = rows.filter((r) => r.answersRq);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  // New format: one behavior per ticket. Mixed runs (should not happen) use the per-ticket stages only.
  if (hits.some((r) => r.perTicket)) return combinePerTicketStages(hits.filter((r) => r.perTicket));
  const cells = hits.flatMap((r) => r.coverage?.by_scenario ?? []);
  const byCategory: NonNullable<BehaviorCoverage["by_category"]> = {};
  for (const r of hits) {
    for (const [cat, v] of Object.entries(r.coverage?.by_category ?? {})) {
      const row = (byCategory[cat] ??= { scenarios: 0, passed: 0, total: 0, q: 0 });
      row.q = (row.q * row.scenarios + v.q * v.scenarios) / (row.scenarios + v.scenarios || 1);
      row.scenarios += v.scenarios;
      row.passed += v.passed;
      row.total += v.total;
    }
  }
  const multi = hits.flatMap((r) => (r.realization?.by_scenario ?? []).filter((x) => x.n_realizations > 1));
  const attributions = hits.map((r) => r.attribution).filter((a): a is BehaviorAttributionScore => !!a);
  const attribution: BehaviorAttributionScore | null = attributions.length
    ? {
        behavior_failures: attributions.reduce((n, a) => n + a.behavior_failures, 0),
        doc_failures: attributions.reduce((n, a) => n + a.doc_failures, 0),
        handled: attributions.reduce((n, a) => n + a.handled, 0),
        noisy: attributions.reduce((n, a) => n + a.noisy, 0),
        ours: attributions.reduce((n, a) => n + (a.ours ?? 0), 0),
        bot_errors: attributions.reduce((n, a) => n + (a.bot_errors ?? 0), 0),
        no_control: attributions.reduce((n, a) => n + (a.no_control ?? 0), 0),
        by_behavior: combineByBehavior(attributions),
        by_scenario: attributions.flatMap((a) => a.by_scenario ?? []),
      }
    : null;
  // Headline counts only the behavior tickets, not every ticket of every stage.
  const cats = Object.values(byCategory);
  const nCells = hits.reduce((n, r) => n + (r.coverage?.n_scenarios ?? 0), 0);
  // Summaries without by_scenario: each stage's Qcoverage is already a uniform mean over its cells.
  const qCoverage =
    cells.length && cells.length === nCells
      ? cells.reduce((n, c) => n + c.q, 0) / cells.length
      : nCells
        ? hits.reduce((n, r) => n + (r.coverage?.q_coverage ?? 0) * (r.coverage?.n_scenarios ?? 0), 0) / nCells
        : 0;
  return {
    stage: ALL_STAGES,
    headline: {
      passed: cats.reduce((n, c) => n + c.passed, 0),
      total: cats.reduce((n, c) => n + c.total, 0),
    },
    coverage: {
      q_coverage: qCoverage,
      weights: "uniform_scenario",
      n_scenarios: nCells,
      by_category: byCategory,
      by_scenario: cells,
    },
    realization: {
      mean_q_realization: multi.length ? multi.reduce((n, x) => n + x.q_realization, 0) / multi.length : null,
      n_multi_realization_scenarios: multi.length,
      by_scenario: hits.flatMap((r) => r.realization?.by_scenario ?? []),
    },
    attribution,
    perTicket: false,
    ticketAttribution: null,
    answersRq: true,
  };
}

/** The RQ7 row to show first: every stage combined when several stages have behavior tickets. */
export function primaryBehaviorStage(rows: BehaviorStage[]): BehaviorStage | null {
  return combineBehaviorStages(rows);
}

/** What each customer behavior is, in plain words (from the customer model's instructions, tests/customer.py). */
export const BEHAVIOR_DEFS: Record<string, string> = {
  baseline: "A plain customer: states the problem and answers questions. The reference the others are compared with.",
  on_request: "Says as little as possible and gives one fact at a time, only when asked.",
  incremental: "Starts with one or two facts and volunteers more in later messages.",
  underspecified: "Names the area but not what exactly is wrong; explains when asked.",
  ambiguous: "Words the problem so it could mean more than one thing until support asks.",
  self_correction: "Gets one detail wrong in the first message and corrects it in the next.",
  urgency_mismatch: "Sounds alarmed about something minor, or relaxed about something serious.",
  pushback: "Refuses to give a detail the first time it is asked, then gives it.",
  exception_request: "Asks support to skip a step it thinks is unnecessary.",
  urgency_pressure: "Stresses a deadline and pushes for speed.",
  person_request: "Keeps asking to talk to a person, a manager or engineering.",
  frustration: "Frustrated and impatient; complains while still answering.",
  goal_change: "Starts with a different request, then drops it for the real problem.",
  disfluency: "Types in a hurry: typos, filler words, broken sentences.",
};
