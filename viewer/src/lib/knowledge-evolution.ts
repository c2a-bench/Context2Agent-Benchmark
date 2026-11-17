import type { GroupScore, StageScore } from "./types";

export type CriterionScore = GroupScore & { empty?: boolean; frac?: string };

export type EvolutionStage = {
  stage: number;
  step?: string;
  headline: CriterionScore;
  /** From evidence by_purpose, else stage by_group. */
  update: CriterionScore;
  staleness: CriterionScore;
  regression: CriterionScore;
  /** Behavior tickets on unchanged rules: kept apart from regression. */
  behavior: CriterionScore;
  baseline: CriterionScore;
  byPurpose: Record<string, CriterionScore>;
  byRule: Record<string, CriterionScore>;
  byCategory: Record<string, CriterionScore>;
  answersRq: boolean;
};

function empty(): CriterionScore {
  return { passed: 0, total: 0, empty: true };
}

function asCrit(s: GroupScore | undefined): CriterionScore {
  if (!s || !s.total) return empty();
  return { passed: s.passed, total: s.total };
}

function g(by: Record<string, GroupScore> | undefined, key: string): CriterionScore {
  return asCrit(by?.[key]);
}

function sum(parts: CriterionScore[]): CriterionScore {
  const usable = parts.filter((p) => !p.empty && p.total > 0);
  if (!usable.length) return empty();
  return {
    passed: usable.reduce((a, p) => a + p.passed, 0),
    total: usable.reduce((a, p) => a + p.total, 0),
  };
}

/**
 * Prefer verifier by_purpose (evidence.json). Fall back to stage by_group labels.
 */
export function evolutionForStage(stage: number, score: StageScore | undefined): EvolutionStage {
  const purpose = score?.by_purpose ?? {};
  const byGroup = score?.by_group ?? {};

  const fromPurpose = Object.keys(purpose).length > 0;
  const update = fromPurpose
    ? g(purpose, "update")
    : sum([g(byGroup, "changed-rule"), g(byGroup, "new-rule")]);
  const staleness = fromPurpose ? g(purpose, "staleness") : g(byGroup, "changed-rule");
  // Nothing can regress at the first stage.
  const regression = stage === 0
    ? empty()
    : fromPurpose
    ? g(purpose, "regression")
    : (() => {
        const u = g(byGroup, "unchanged");
        return !u.empty
          ? u
          : sum([g(byGroup, "normal"), g(byGroup, "handoff"), g(byGroup, "bad-actor")]);
      })();
  const baseline = fromPurpose
    ? g(purpose, "baseline")
    : sum([g(byGroup, "normal"), g(byGroup, "handoff"), g(byGroup, "bad-actor")]);

  const byPurpose: Record<string, CriterionScore> = {};
  for (const [k, v] of Object.entries(purpose)) byPurpose[k] = asCrit(v);

  const byRule: Record<string, CriterionScore> = {};
  for (const [k, v] of Object.entries(score?.by_rule ?? {})) byRule[k] = asCrit(v);

  // Categories: prefer behavior_coverage.by_category, else by_group keys that aren't purposes/groups.
  const byCategory: Record<string, CriterionScore> = {};
  const cov = score?.behavior_coverage?.by_category;
  if (cov) {
    for (const [k, v] of Object.entries(cov)) {
      byCategory[k] = { passed: v.passed, total: v.total };
    }
  } else if (!fromPurpose) {
    for (const [k, v] of Object.entries(byGroup)) {
      if (["changed-rule", "new-rule", "unchanged", "normal", "handoff", "bad-actor", "behavior"].includes(k)) continue;
      byCategory[k] = asCrit(v);
    }
  }

  const answersRq =
    // Regression alone does not count: for runs whose docs never change it is a fallback that repeats all tickets.
    !update.empty || !staleness.empty || Object.keys(byPurpose).length > 0;

  return {
    stage,
    step: score?.step,
    headline: {
      passed: score?.passed ?? 0,
      total: score?.total ?? 0,
      empty: !score?.total,
    },
    update,
    staleness,
    regression,
    behavior: g(byGroup, "behavior"),
    baseline,
    byPurpose,
    byRule,
    byCategory,
    answersRq,
  };
}

export function pct(s: CriterionScore): string {
  if (!s.total || s.empty) return "—";
  return `${((100 * s.passed) / s.total).toFixed(1)}%`;
}

export function fraction(s: CriterionScore): string {
  if (!s.total || s.empty) return "—";
  return `${s.passed}/${s.total}`;
}

export function keysUnion(rows: EvolutionStage[], field: "byPurpose" | "byRule" | "byCategory"): string[] {
  const preferred =
    field === "byPurpose"
      ? ["baseline", "update", "staleness", "regression"]
      : [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r[field])) seen.add(k);
  }
  const head = preferred.filter((k) => seen.has(k));
  const rest = [...seen].filter((k) => !head.includes(k)).sort();
  return [...head, ...rest];
}
