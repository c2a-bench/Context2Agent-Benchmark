import type { JobSummary } from "@/lib/data";

// The environments the current results come from, in display order, and when their tickets were last reworked:
// runs started before that date are on an older ticket version and are marked so.
// architectures: the environment fixes one architecture per run (Skyway), so a model's runs of different
// architectures are one entry; the viewer asks which architecture to show.
/** A run started before `current` (an older version of the tickets). The published datasets carry no start dates and
 *  hold only current runs, so a run without a date is current. */
export const olderThan = (j: { started?: string | null }, current?: string) => !!current && !!j.started && j.started < current;

export const FOCUS: { id: string; short: string; current: string; blurb: string; architectures?: boolean }[] = [
  {
    id: "redwood-inference",
    short: "Redwood",
    current: "2026-10-15",
    blurb: "A builder turns Redwood Inference's messy support docs into a support agent, then updates it as the docs change over six stages. A customer model plays the person who wrote in.",
  },
  {
    id: "support-agent-knowledge",
    short: "Knowledge packs",
    current: "2026-10-15",
    blurb: "The same tickets and instructions every time; only the docs change, packaged five ways (complete, fragmented, incomplete, conflicting, noisy). Shows how much the shape of the knowledge alone costs.",
  },
  {
    id: "skyway-air",
    short: "Skyway architectures",
    current: "2026-11-06",
    blurb: "Skyway Air with the architecture fixed per run: the same builder model builds six agents, one per way of storing and finding the docs (raw docs, an LLM wiki or a knowledge graph; index search, terminal tools, graph queries or no retrieval).",
    architectures: true,
  },
];

/** Passed over answerable tickets (total minus those lost to us), every stage of the run pooled. */
export function passRate(j: JobSummary) {
  const p = j.scores.reduce((a, s) => a + (s.passed ?? 0), 0);
  const n = j.scores.reduce((a, s) => a + (s.total ?? 0) - (s.ours ?? 0), 0);
  return n ? { rate: p / n, passed: p, total: n } : null;
}

/** A finished architecture run named by its start time (2026-11-06__13-52-30, or its -facts copy): test runs given
 *  their own names (smoke-*) are not on the leaderboard or in the picker. */
// A run folder starts with its date: its start time (2026-11-14__07-45-58), or a republished run's date, model and
// architecture (20261117--claude-opus-5-5--raw-index, 20261118-recovered--deepseek-flash--raw-index).
const isRun = (j: JobSummary) => !!j.architecture && j.finished && j.scores.length > 0 && /^(\d{4}-\d{2}-\d{2}__|\d{8}\b)/.test(j.id);

/** An architectures environment's runs as one entry per builder model (and thinking setting): its newest run and its
 *  run of each architecture. */
export function architectureGroups(jobs: JobSummary[], current?: string): { lead: JobSummary; runs: JobSummary[] }[] {
  const seen = new Set<string>();
  const out: { lead: JobSummary; runs: JobSummary[] }[] = [];
  for (const j of jobs) {
    if (!isRun(j)) continue;
    const key = `${model(j.builder.model)}|${j.thinking ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lead: j, runs: architectureRuns(jobs, j, current) });
  }
  return out;
}

/** A model's run of each architecture: the latest finished one per architecture, its -facts copy when there is one
 *  (jobs come newest first, a -facts copy before its run). Sorted by architecture name. With `current` (the date the
 *  environment's tickets last changed), only runs on the same tickets as `of`, so pooled scores compare like with like. */
export function architectureRuns(jobs: JobSummary[], of: JobSummary, current?: string): JobSummary[] {
  const onCurrent = (j: JobSummary) => !olderThan(j, current);
  const seen = new Set<string>();
  const out: JobSummary[] = [];
  for (const j of jobs) {
    if (!isRun(j)) continue;
    if (model(j.builder.model) !== model(of.builder.model) || (j.thinking ?? "") !== (of.thinking ?? "")) continue;
    if (current && onCurrent(j) !== onCurrent(of)) continue;
    const arch = j.architecture ?? "";
    if (seen.has(arch)) continue;
    seen.add(arch);
    out.push(j);
  }
  return out.sort((a, b) => (a.architecture ?? "").localeCompare(b.architecture ?? ""));
}

const model = (m: string | null | undefined) => (m ? m.split("/").pop()! : "unknown");

/** The runs on an environment's leaderboard, in its order: the latest finished run per builder model (jobs come newest
 *  first), plus the latest run of each other thinking setting of that model on the current tickets. */
export function leaderboardRuns(jobs: JobSummary[], current: string): JobSummary[] {
  const seen = new Set<string>();
  const done = jobs.filter((j) => j.finished && j.scores.length);
  return [
    ...done.filter((j) => {
      const m = `${model(j.builder.model)}|${j.architecture ?? ""}`;
      if (seen.has(m)) return false;
      seen.add(m);
      seen.add(`${m}|${j.thinking ?? ""}`);
      return true;
    }),
    ...done.filter((j) => {
      const key = `${model(j.builder.model)}|${j.architecture ?? ""}|${j.thinking ?? ""}`;
      if (!j.thinking || olderThan(j, current) || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

/** Why a run of a leaderboard environment is not on its leaderboard, or null when it is (or the environment has none). */
export function offLeaderboard(task: string, j: JobSummary, jobs: JobSummary[]): string | null {
  const env = FOCUS.find((f) => f.id === task);
  if (!env) return null;
  const shown = new Set(leaderboardRuns(jobs, env.current).map((x) => x.key));
  if (shown.has(j.key)) return null;
  if (!j.finished || !j.scores.length) return "Not on the leaderboard: the run did not finish";
  if (olderThan(j, env.current)) return "Not on the leaderboard: an older version of the tickets";
  const facts = jobs.find((x) => x.id === `${j.id}-facts`);
  if (facts && shown.has(facts.key)) return "Not on the leaderboard: it shows this run's -facts copy (graded by facts)";
  return j.architecture
    ? `Not on the leaderboard: a newer ${j.architecture} run of this model is on it`
    : "Not on the leaderboard: a newer run of this model is on it";
}
