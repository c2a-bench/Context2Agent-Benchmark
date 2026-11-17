import type { JobSummary, PublishedIndex } from "./data-types";
import type { BuildEvent, BuildsData, CasesData, CaseVersion, CodeData, CodeStage, Doc, DocsData, Meta, StageScore, Ticket, Transition } from "./types";

export type DatasetRef = { repository: string; revision: string; path: string; inventorySha256: string };
export type DatasetRelease = { schemaVersion: 2; provider: "huggingface"; domains: string[]; benchmark: DatasetRef; runs: DatasetRef };
export type TaskStage = { index: number; label: string; kind: "update" | "condition"; docs_mode: "delta" | "snapshot" };
export type BenchmarkTask = { schema_version: 2; id: string; name: string; description: string; sources: { label: string; url: string }[]; source_domain: string; stages: TaskStage[] };
export type BenchmarkCase = Omit<CaseVersion, "step" | "result"> & { id: string };
export type StageChanges = { changes: Transition["docChanges"]; rule_changes: Transition["ruleChanges"]; new_docs: Transition["newDocs"]; deleted: string[] };
export type RunRecord = {
  schema_version: 2; domain: string; job: string; source_domain: string; source_job: string;
  benchmark: { repository: string; revision: string | null; inventorySha256: string };
  stages: number[]; builder: JobSummary["builder"]; bot: string | null; thinking: string | null; architecture: string | null;
  started: string | null; finished: boolean; cost: number | null; tokens: JobSummary["tokens"];
  setup_min: number | null; total_min: number | null; score: number | null; score_aggregation: "published_trial_reward"; trial: string; built?: string; failure_summary?: unknown; source_meta?: Record<string, unknown>;
};
export type StageRecord = {
  stage: number; label: string; score: StageScore & { change_sources?: JobSummary["scores"][number]["change_sources"] }; builder: CodeStage["builder"];
  build_min: number | null; grade_min: number | null;
  build_log: { available: boolean; harness: string | null; version: number; format: "trajectory" | "pi" | null; summary: BuildsData["stages"][number]["summary"] | null };
};
export type ResultRecord = Partial<Ticket> & { id: string; passed: boolean; verdict: string | null; grading: NonNullable<CaseVersion["result"]>; trace_available: boolean };
export type StageCode = { files: CodeStage["files"]; knowledge: CodeStage["knowledge"]; changes: Pick<Transition, "files" | "knowledge"> };
export type BuilderRecord = { format: "normalized-events-v1"; redacted: true; events: BuildEvent[] };
export type LeaderboardRow = JobSummary & { domain: string; benchmark_revision: string | null; benchmark_inventory_sha256: string };
export const canonicalDomain = (domain: string) => ["skyway-arch", "skyway-arch-large", "skyway-arch-regraded"].includes(domain) ? "skyway-air" : domain;

/** Reconstruct the old UI projection without duplicating benchmark definitions in each run. */
export function caseTicketBase(c: BenchmarkCase): Partial<Ticket> {
  const tags = c.tags as Record<string, unknown>;
  return {
    id: c.id, title: c.title, test: c.test, matters: c.matters, brief: c.brief, ticket: c.ticket,
    facts: c.facts.map((fact) => fact.text), customerId: c.customer.id, group: String(tags.group ?? ""),
    scenario: (tags.scenario ?? null) as string | null, category: (tags.category ?? null) as string | null,
    realization: (tags.realization ?? null) as string | null, behavior: (tags.behavior ?? null) as string | null,
    infoType: (tags.info_type ?? null) as number | null, ticketType: (tags.type ?? null) as string | null,
  };
}
export function makeLeaderboardRow(run: RunRecord, stages: StageRecord[]): LeaderboardRow {
  const scores = stages.map(({ stage, score }) => ({ stage, passed: score.passed, total: score.total, ours: score.ours,
    by_group: score.by_group, behavior_coverage: score.behavior_coverage,
    realization_robustness: score.realization_robustness, change_sources: score.change_sources,
  }));
  return { domain: run.domain, key: `${run.domain}.${run.job}`, id: run.job, started: run.started, finished: run.finished,
    builder: run.builder, bot: run.bot, thinking: run.thinking, architecture: run.architecture,
    cost: run.cost, tokens: run.tokens, score: run.score, scores,
    benchmark_revision: run.benchmark.revision, benchmark_inventory_sha256: run.benchmark.inventorySha256 };
}

type Reader = <T>(side: "benchmark" | "runs", file: string) => Promise<T>;
export function createDatasetLoader(options: { release: DatasetRelease; read: Reader; text: (side: "runs", file: string) => Promise<string>; allowPending?: boolean }) {
  const { release, read } = options;
  const promises = new Map<string, Promise<unknown>>();
  const memo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!promises.has(key)) { const promise = fn(); promises.set(key, promise); promise.catch(() => promises.delete(key)); }
    return promises.get(key) as Promise<T>;
  };
  const task = (domain: string) => memo(`task:${domain}`, () => read<BenchmarkTask>("benchmark", `${domain}/task.json`));
  const run = (domain: string, job: string) => memo(`run:${domain}/${job}`, async () => {
    const value = await read<RunRecord>("runs", `${domain}/${job}/run.json`);
    if (value.domain !== domain || value.job !== job || value.benchmark.repository !== release.benchmark.repository || value.benchmark.inventorySha256 !== release.benchmark.inventorySha256 || (value.benchmark.revision !== release.benchmark.revision && !(options.allowPending && value.benchmark.revision === null))) throw new Error(`Benchmark provenance mismatch for ${domain}/${job}`);
    return value;
  });
  const stage = (domain: string, job: string, n: number) => memo(`stage:${domain}/${job}/${n}`, () => read<StageRecord>("runs", `${domain}/${job}/stages/${n}/stage.json`));
  const definitions = (domain: string, n: number) => memo(`cases:${domain}/${n}`, () => read<BenchmarkCase[]>("benchmark", `${domain}/stages/${n}/cases.json`));
  const results = (domain: string, job: string, n: number) => memo(`results:${domain}/${job}/${n}`, () => read<ResultRecord[]>("runs", `${domain}/${job}/stages/${n}/results.json`));
  const changes = (domain: string, n: number) => memo(`changes:${domain}/${n}`, () => read<StageChanges>("benchmark", `${domain}/stages/${n}/changes.json`));
  const index = () => memo("index", async (): Promise<PublishedIndex> => ({ updatedAt: release.runs.revision, prefix: "", tasks: await Promise.all(release.domains.map(async (domain) => {
    const metadata = await task(domain);
    const text = await options.text("runs", `data/${domain}.jsonl`);
    const jobs = text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as LeaderboardRow) : [];
    for (const job of jobs) if (job.domain !== domain || job.benchmark_inventory_sha256 !== release.benchmark.inventorySha256 || (job.benchmark_revision !== release.benchmark.revision && !(options.allowPending && job.benchmark_revision === null))) throw new Error(`Invalid leaderboard provenance: ${domain}`);
    return { id: domain, name: metadata.name, description: metadata.description, sources: metadata.sources, jobs };
  })) }));
  const interactions = (domain: string, job: string) => memo(`interactions:${domain}/${job}`, async () => {
    const record = await run(domain, job);
    return (await Promise.all(record.stages.map(async (n) => {
      const byId = new Map((await definitions(domain, n)).map((c) => [c.id, c]));
      return (await results(domain, job, n)).filter((r) => r.trace_available).map((r) => {
        const c = byId.get(r.id); if (!c) throw new Error(`Unknown case ${r.id}`);
        const { grading: _grading, trace_available: _trace, verdict: _verdict, ...trace } = r;
        return { ...caseTicketBase(c), ...trace, stage: n } as Ticket;
      });
    }))).flat();
  });
  const meta = (domain: string, job: string) => memo(`meta:${domain}/${job}`, async (): Promise<Meta> => {
    const r = await run(domain, job), ss = await Promise.all(r.stages.map((n) => stage(domain, job, n)));
    return { ...r.source_meta, job: String(r.source_meta?.job ?? r.source_job), trial: r.trial, builder: (r.source_meta?.builder as Meta["builder"]) ?? r.builder, bot: (r.source_meta?.bot as Meta["bot"]) ?? r.bot, stages: r.stages,
      scores: Object.fromEntries(ss.map((s) => [String(s.stage), s.score])),
      timing: { setup_min: r.setup_min, total_min: r.total_min, steps: Object.fromEntries(ss.map((s) => [s.label, { build_min: s.build_min, grade_min: s.grade_min }])) } };
  });
  const docs = (domain: string) => memo(`docs:${domain}`, async (): Promise<DocsData> => {
    let effective: Record<string, Doc> = {};
    const output: DocsData = {};
    for (const s of (await task(domain)).stages) {
      const [delta, change] = await Promise.all([read<Record<string, Doc>>("benchmark", `${domain}/stages/${s.index}/docs.json`), changes(domain, s.index)]);
      effective = s.docs_mode === "snapshot" ? { ...delta } : { ...effective, ...delta };
      for (const key of change.deleted) delete effective[key];
      output[String(s.index)] = effective;
    }
    return output;
  });
  const code = (domain: string, job: string) => memo(`code:${domain}/${job}`, async (): Promise<CodeData> => {
    const r = await run(domain, job), stages: CodeData["stages"] = [], transitions: Transition[] = [];
    for (let i = 0; i < r.stages.length; i++) {
      const n = r.stages[i];
      const [s, c, b] = await Promise.all([stage(domain, job, n), read<StageCode>("runs", `${domain}/${job}/stages/${n}/code.json`), changes(domain, n)]);
      stages.push({ stage: n, score: { passed: s.score.passed, total: s.score.total }, builder: s.builder, files: c.files, knowledge: c.knowledge });
      if (i) transitions.push({ from: r.stages[i - 1], to: n, docChanges: b.changes, newDocs: b.new_docs, ruleChanges: b.rule_changes, files: c.changes.files, knowledge: c.changes.knowledge });
    }
    return { stages, transitions };
  });
  const cases = (domain: string, job: string) => memo(`cases:${domain}/${job}`, async (): Promise<CasesData> => {
    const r = await run(domain, job), items = new Map<string, CasesData["tickets"][number]>();
    const labels: string[] = [];
    for (const n of r.stages) {
      const s = await stage(domain, job, n); labels.push(s.label);
      const outcome = new Map((await results(domain, job, n)).map((row) => [row.id, row.grading]));
      for (const c of await definitions(domain, n)) {
        const { id, ...definition } = c;
        if (!outcome.has(id)) throw new Error(`Missing result ${domain}/${job}/${n}/${id}`);
        if (!items.has(id)) items.set(id, { id, versions: [] });
        items.get(id)!.versions.push({ ...definition, step: s.label, result: outcome.get(id)! });
      }
    }
    return { task: domain, steps: labels, tickets: [...items.values()] };
  });
  const builds = (domain: string, job: string) => memo(`builds:${domain}/${job}`, async (): Promise<BuildsData | null> => {
    const r = await run(domain, job), ss = await Promise.all(r.stages.map((n) => stage(domain, job, n)));
    if (!ss.some((s) => s.build_log.available)) return null;
    return { version: 1, harness: ss.find((s) => s.build_log.harness)?.build_log.harness ?? null, stages: ss.filter((s) => s.build_log.summary).map((s) => ({ index: s.stage, step: s.label, format: s.build_log.format, summary: s.build_log.summary! })) };
  });
  const events = async (domain: string, job: string, n: number) => {
    if (!(await stage(domain, job, n)).build_log.available) return [];
    return (await read<BuilderRecord>("runs", `${domain}/${job}/stages/${n}/builder.json`)).events;
  };
  const text = (ref: string) => memo(`text:${ref}`, async () => {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error("Invalid content reference");
    const shard = await read<Record<string, string>>("runs", `content/texts/${ref.slice(0, 2)}.json`);
    if (typeof shard[ref] !== "string") throw new Error(`Missing content ${ref}`);
    return shard[ref];
  });
  return { index, task, run, stage, definitions, results, meta, interactions, docs, code, cases, builds, events, text };
}
