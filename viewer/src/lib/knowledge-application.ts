import type { FailureParty, FailureTaxonomy, StageScore, Ticket } from "./types";

export type KnowledgeApplication = NonNullable<StageScore["knowledge_application"]>;

export type AcquisitionStage = {
  stage: number;
  score: StageScore;
  ka: KnowledgeApplication | null;
  answersRq: boolean;
};

export function fmtQ(q: number | null | undefined): string {
  if (q == null || Number.isNaN(q)) return "—";
  return q.toFixed(2);
}

export function acquisitionForStage(
  stage: number,
  score: StageScore | undefined,
): AcquisitionStage {
  const ka = score?.knowledge_application ?? null;
  const answersRq = !!(
    ka &&
    (ka.replayed > 0 ||
      ka.failed > 0 ||
      (ka.by_blame && Object.keys(ka.by_blame).length > 0) ||
      ka.subset)
  );
  return { stage, score: score ?? {}, ka, answersRq };
}

export function primaryAcquisitionStage(rows: AcquisitionStage[]): AcquisitionStage | null {
  const withReplay = [...rows].reverse().find((r) => (r.ka?.replayed ?? 0) > 0);
  if (withReplay) return withReplay;
  return [...rows].reverse().find((r) => r.answersRq) ?? null;
}

export const BLAME_BUCKETS = [
  { key: "acquisition", label: "Acquisition", blames: ["not kept", "not retrieved", "retrieval", "no tools", "fact absent"] },
  {
    key: "runtime",
    label: "Runtime realization",
    blames: [
      "misapplied rule", "rule buried", "trap doc", "chose trap doc", "stale copy", "code decided", "execution",
      "wrong assertion", "missing assertion", "missed customer fact",
      // Fact-graded runs name the end-state symptom itself (scripts/failure_types.py).
      "wrong value", "missing value", "missing label", "extra label", "forbidden action", "missing required action",
      "protected state changed",
    ],
  },
  { key: "bot_failure", label: "Agent failure", blames: ["crashed", "context overflow", "model call failed", "no model call", "too slow"] },
  { key: "harness", label: "Harness", blames: ["our limit", "our service", "customer fault", "runner crashed", "trace lost"] },
] as const;

export type BucketKey = (typeof BLAME_BUCKETS)[number]["key"];
export type Buckets = { records: number; counts: Record<BucketKey, number> };

/** Figure 1 buckets over every blame record. Older scores.json lack the agent/harness fields: rebuild from by_blame. */
export function blameBuckets(ka: KnowledgeApplication | null | undefined): Buckets {
  const counts: Record<BucketKey, number> = { acquisition: 0, runtime: 0, bot_failure: 0, harness: 0 };
  if (!ka) return { records: 0, counts };
  const by = ka.by_blame ?? {};
  if (ka.blame_bot_failure != null) {
    counts.acquisition = ka.blame_acquisition ?? 0;
    counts.runtime = ka.blame_runtime ?? 0;
    counts.bot_failure = ka.blame_bot_failure ?? 0;
    counts.harness = ka.blame_harness ?? 0;
  } else {
    for (const b of BLAME_BUCKETS) counts[b.key] = b.blames.reduce((a, k) => a + (by[k] ?? 0), 0);
  }
  const records = ka.blame_records ?? Object.values(by).reduce((a, n) => a + n, 0);
  return { records, counts };
}

export function poolBuckets(list: Buckets[]): Buckets {
  const counts: Record<BucketKey, number> = { acquisition: 0, runtime: 0, bot_failure: 0, harness: 0 };
  let records = 0;
  for (const b of list) {
    records += b.records;
    for (const k of Object.keys(counts) as BucketKey[]) counts[k] += b.counts[k];
  }
  return { records, counts };
}

export function bucketFrac(b: Buckets, k: BucketKey): number | null {
  return b.records ? b.counts[k] / b.records : null;
}

const ACQ_BLAMES: readonly string[] = BLAME_BUCKETS[0].blames;

export function replayReason(t: { replay_passed: boolean; blame?: string[]; reason?: string }): string {
  if (t.reason) return t.reason;
  if (!t.replay_passed) return "cannot apply";
  return (t.blame ?? []).some((b) => ACQ_BLAMES.includes(b)) ? "lacked the rule" : "fixed when told";
}

/** Replay classes: passed with an acquisition blame = acquisition ("lacked the rule"); otherwise runtime.
 *  Older scores.json lack replay_reasons: rebuild from the replayed tickets. */
export function replayClasses(ka: KnowledgeApplication | null | undefined) {
  if (!ka || !ka.replayed) return null;
  let reasons = ka.replay_reasons;
  let acquisition = ka.frac_knowledge_acquisition_failure;
  let runtime = ka.frac_runtime_realization_failure;
  if (!reasons && ka.tickets?.length) {
    reasons = {};
    for (const t of ka.tickets) {
      const r = replayReason(t);
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
    const n = ka.tickets.length;
    acquisition = (reasons["lacked the rule"] ?? 0) / n;
    runtime = 1 - acquisition;
  } else if (!reasons) {
    // Older scores without reasons or tickets stored these two fractions the other way round.
    acquisition = null;
    runtime = null;
  }
  return { acquisition, runtime, reasons: reasons ?? {}, replayed: ka.replayed };
}

/** Level-3 failure taxonomy in display order: party, then family, then type. */
export const FAILURE_TAXONOMY: { party: FailureParty; family: string; types: string[] }[] = [
  { party: "Builder", family: "Context recall", types: ["rule never kept", "kept, not in context", "fact absent"] },
  { party: "Builder", family: "Context precision", types: ["wrong or stale source", "rule diluted", "context budget exceeded"] },
  {
    party: "Bot",
    family: "Tool failure",
    types: [
      "wrong value",
      "missing value",
      "missing label",
      "extra label or write",
      "forbidden action",
      "missing required action",
      "protected state changed",
      "tool design gap",
    ],
  },
  { party: "Bot", family: "NL assertion failure", types: ["wrong or prohibited assertion", "missing assertion"] },
  { party: "Bot", family: "Information gathering", types: ["decisive fact not obtained"] },
  { party: "Bot", family: "Robustness", types: ["crash", "model call failed", "no model call", "time limit on every try"] },
  { party: "Harness", family: "Resource limit", types: ["time limit"] },
  { party: "Harness", family: "Fault or crash", types: ["our runner crashed"] },
  { party: "Harness", family: "Trace or service", types: ["provider failure", "customer model failure", "trace lost"] },
];

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

export type TaxonomyView = { taxonomy: FailureTaxonomy; derived: boolean };

/** The grader's failure_taxonomy, or (older runs) one rebuilt from knowledge_application.by_blame. */
export function failureTaxonomy(score: StageScore | null | undefined): TaxonomyView | null {
  if (score?.failure_taxonomy) return { taxonomy: score.failure_taxonomy, derived: false };
  const by = score?.knowledge_application?.by_blame;
  if (!by) return null;
  const t: FailureTaxonomy = { records: 0, by_party: {}, by_family: {}, by_type: {} };
  for (const [label, n] of Object.entries(by)) {
    if (!n) continue;
    const [party, family, type] = BLAME_TYPES[label] ?? ["Bot", "Tool failure", SYMPTOM_NOT_RECORDED];
    const row = (t.by_type[type] ??= { party, family, count: 0 });
    row.count += n;
    t.by_family[`${party} / ${family}`] = (t.by_family[`${party} / ${family}`] ?? 0) + n;
    t.by_party[party] = (t.by_party[party] ?? 0) + n;
    t.records += n;
  }
  return { taxonomy: t, derived: true };
}

/** Table rows in taxonomy order (zero rows dropped); unknown types go last within their family. */
export function taxonomyRows(t: FailureTaxonomy): { party: string; family: string; type: string; count: number }[] {
  const rank = (party: string, family: string, type: string) => {
    const fi = FAILURE_TAXONOMY.findIndex((f) => f.party === party && f.family === family);
    const pi = FAILURE_PARTIES.indexOf(party as FailureParty);
    const ti = fi < 0 ? -1 : FAILURE_TAXONOMY[fi].types.indexOf(type);
    return [pi < 0 ? FAILURE_PARTIES.length : pi, fi < 0 ? FAILURE_TAXONOMY.length : fi, ti < 0 ? 99 : ti];
  };
  return Object.entries(t.by_type)
    .filter(([, v]) => v.count > 0)
    .map(([type, v]) => ({ party: v.party, family: v.family, type, count: v.count, r: rank(v.party, v.family, type) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.type.localeCompare(b.type))
    .map(({ party, family, type, count }) => ({ party, family, type, count }));
}

/** Family totals ("Party / Family") in taxonomy order, zero rows dropped. */
export function taxonomyFamilies(t: FailureTaxonomy): { key: string; count: number }[] {
  const order = FAILURE_TAXONOMY.map((f) => `${f.party} / ${f.family}`);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.entries(t.by_family)
    .filter(([, n]) => n > 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

/** Party counts summed over stages. */
export function poolParties(list: (TaxonomyView | null)[]): Record<FailureParty, number> {
  const out: Record<FailureParty, number> = { Builder: 0, Bot: 0, Harness: 0 };
  for (const v of list) for (const p of FAILURE_PARTIES) out[p] += v?.taxonomy.by_party[p] ?? 0;
  return out;
}

/** Failed tickets by blame bucket: a ticket whose blame records fall in several buckets is split evenly between them;
 *  "none" = a failed ticket with no blame record. Uses every blame record when the viewer data has them. */
export function ticketBuckets(tickets: Ticket[]): Record<BucketKey | "none", number> {
  const out: Record<BucketKey | "none", number> = { acquisition: 0, runtime: 0, bot_failure: 0, harness: 0, none: 0 };
  for (const t of tickets) {
    if (t.passed) continue;
    const labels = t.blames ? t.blames.map((b) => b.label) : t.failures.map((f) => f.fault?.label);
    const keys = [...new Set(labels.map((l) => (l ? BLAME_BUCKETS.find((b) => (b.blames as readonly string[]).includes(l))?.key ?? "none" : "none")))];
    for (const k of keys.length ? keys : (["none"] as const)) out[k] += 1 / (keys.length || 1);
  }
  return out;
}

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

/** Plain-language definitions of the failure parties, families and types, for hover help. */
export const FAILURE_DEFS: Record<string, string> = {
  Builder: "The builder's fault: the knowledge the ticket needs never reached the agent, or reached it in a confusing form.",
  Bot: "The agent's fault: it had what it needed and still did the wrong thing.",
  Harness: "Our fault, not the model's: a time limit, a provider error or a lost trace.",
  "no blame recorded": "A failed ticket the grader could not attribute.",
  "Context recall": "The rule the ticket needs never reached the agent: the builder did not keep it, or kept it where the agent never looked.",
  "Context precision": "The rule reached the agent but in a confusing form: an outdated or look-alike page next to it, too much other text around it, or a prompt over its size cap.",
  "Tool failure": "The agent had the rule and still set a wrong or missing value, or took an action it should not have.",
  "NL assertion failure": "What the agent told the customer was wrong, or it left out something it had to say.",
  Robustness: "The agent crashed or could not reach its model.",
  "rule never kept": "The builder never put the rule anywhere in the agent.",
  "kept, not in context": "The rule is in the agent's files, but it never reached the model for this ticket.",
  "wrong or stale source": "The agent followed an outdated or look-alike page instead of the right one.",
  "rule diluted": "The rule was in the prompt, but the agent only followed it once it was stated plainly.",
  "context budget exceeded": "The agent's prompt grew past the ticket's size cap.",
  "wrong value": "The agent set a field to the wrong value.",
  "missing value": "The agent never set a field it had to set.",
  "missing label": "The agent left out a label the ticket needs.",
  "extra label or write": "The agent added a label or made a change the ticket does not call for.",
  "forbidden action": "The agent did something the rules forbid.",
  "missing required action": "The agent skipped an action the ticket requires.",
  "tool design gap": "The builder's code, not the model, chose the value, or the agent had no tool to do it.",
  crash: "The agent crashed.",
  "Information gathering": "The agent had the rules but did not get a fact only the customer knows and the ticket needs.",
  "fact absent": "The judge found no trace of a fact this check needs in the agent's files.",
  "decisive fact not obtained": "The customer never told the agent a fact the ticket needs: the agent did not ask, or asked the wrong thing.",
};

// ---- Plain names for the failure groups (the grader's "family") and types, shown on screen.
export const FAMILY_LABEL: Record<string, string> = {
  "Context recall": "Knowledge missing",
  "Context precision": "Knowledge muddled",
  "Tool failure": "Wrong action or value",
  "NL assertion failure": "Wrong or missing reply",
  "Information gathering": "Didn't ask",
  Robustness: "Agent broke",
  "Resource limit": "Time limit",
  "Fault or crash": "Our runner crashed",
  "Trace or service": "Provider or trace problem",
  none: "No blame recorded",
};
export const FAMILY_HINT: Record<string, string> = {
  "Context recall": "The builder never kept the rule or fact, or kept it where the agent never looked.",
  "Context precision": "The knowledge reached the agent in a confusing form: an outdated page beside it, buried in text, or a prompt over its size cap.",
  "Tool failure": "The agent had the knowledge and still set a wrong or missing value, or took (or skipped) an action.",
  "NL assertion failure": "What the agent told the customer was wrong, or it left out something it had to say.",
  "Information gathering": "The agent never got a fact only the customer knows and the ticket needs.",
  Robustness: "The agent crashed or could not reach its model.",
  none: "A failed ticket the grader could not attribute.",
};
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

/** Group ("family") of a failure type, per the taxonomy; unknown types are the agent's tool failures. */
export function familyOfType(type: string): string {
  return FAILURE_TAXONOMY.find((f) => f.types.includes(type))?.family ?? "Tool failure";
}

/** Failed tickets by type: a ticket counts once, split evenly between the (distinct) types of its blame records;
 *  "none" = a failed ticket with no blame record. A group's count is the sum of its types', so the two always match. */
export function ticketTypeWeights(tickets: Ticket[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tickets) {
    if (t.passed) continue;
    const types = t.blames
      ? t.blames.map((b) => b.type ?? BLAME_TYPES[b.label]?.[2] ?? SYMPTOM_NOT_RECORDED)
      : t.failures.map((f) => f.fault?.taxonomy?.type ?? (f.fault ? BLAME_TYPES[f.fault.label]?.[2] ?? SYMPTOM_NOT_RECORDED : null));
    const keys = [...new Set(types.map((ty) => ty ?? "none"))];
    for (const k of keys.length ? keys : ["none"]) out[k] = (out[k] ?? 0) + 1 / (keys.length || 1);
  }
  return out;
}

/** The same, summed by group. */
export function ticketFamilies(tickets: Ticket[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ty, n] of Object.entries(ticketTypeWeights(tickets))) {
    const k = ty === "none" ? "none" : familyOfType(ty);
    out[k] = (out[k] ?? 0) + n;
  }
  return out;
}
