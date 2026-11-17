import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublishedIndex, JobSummary } from "../../src/lib/data-types";
import type { BuildsData, BuildEvent, CasesData, CodeData, Doc, DocsData, Meta, Ticket } from "../../src/lib/types";
import { canonicalDomain, caseTicketBase, makeLeaderboardRow, type BenchmarkCase, type BenchmarkTask, type ResultRecord, type RunRecord, type StageChanges, type StageCode, type StageRecord } from "../../src/lib/dataset-v2";
import { fingerprint, pool, safePath, snapshotId, type Source, type SourceObject } from "./inventory";
import { canonical, ContentStore, digest, exists, inventoryDirectory, MigrationReader, redact, verifyDirectory, writeJson } from "./migration-io";

export type MigrationOptions = { source: Source; out: string; id: string; benchmarkRepository: string; runsRepository: string; expectedRuns?: number; license?: string; seed?: { root: string; mappings: Record<string, string>; objects: Map<string, SourceObject> }; log?: (message: string) => void };
const without = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const redacted = <T>(value: T): T => typeof value === "string" ? redact(value) as T : Array.isArray(value) ? value.map(redacted) as T : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redacted(item)])) as T : value;
function caseStages(cases: CasesData, meta: Meta) {
  const stages = new Map<number, BenchmarkCase[]>(meta.stages.map((n) => [n, []]));
  const grades = new Map<number, Map<string, NonNullable<CasesData["tickets"][number]["versions"][number]["result"]>>>(meta.stages.map((n) => [n, new Map()]));
  const labels = new Map(meta.stages.map((n) => [meta.scores[String(n)].step, n]));
  for (const ticket of cases.tickets) for (const version of ticket.versions) {
    const n = labels.get(version.step);
    if (n === undefined || !version.result) throw new Error(`Unmapped/ungraded case ${ticket.id}:${version.step}`);
    if (grades.get(n)!.has(ticket.id)) throw new Error(`Duplicate case ${ticket.id}:${n}`);
    const { step: _step, result, ...definition } = version;
    stages.get(n)!.push({ id: ticket.id, ...definition }); grades.get(n)!.set(ticket.id, result);
  }
  for (const values of stages.values()) values.sort((a, b) => a.id.localeCompare(b.id));
  return { stages, grades };
}
async function normalizeDocs(input: DocsData, prefix: string, store: ContentStore) {
  const output: DocsData = {};
  for (const [n, collection] of Object.entries(input)) {
    const docs: Record<string, Doc> = {};
    for (const [name, doc] of Object.entries(collection)) {
      const { ref, ...rest } = doc;
      const text = typeof doc.text === "string" ? doc.text : ref ? await store.resolve(prefix, "texts", ref) : undefined;
      if (typeof text !== "string") throw new Error(`Document content missing: ${prefix}/${n}/${name}`);
      store.put(text, false); docs[name] = { ...rest, text };
    }
    output[n] = docs;
  }
  return output;
}
async function normalizeCode(input: CodeData, prefix: string, store: ContentStore) {
  const file = async <T extends Record<string, unknown>>(value: T): Promise<T> => {
    const output = { ...value } as Record<string, unknown>;
    for (const [inline, reference] of [["text", "ref"], ["old", "old_ref"], ["new", "new_ref"]]) {
      if (typeof value[inline] === "string") { output[reference] = store.put(value[inline] as string); delete output[inline]; }
      else if (typeof value[reference] === "string" && value[reference]) { output[reference] = await store.reference(prefix, "texts", value[reference] as string); delete output[inline]; }
    }
    return output as T;
  };
  const mapFiles = async <T extends Record<string, unknown>>(items: T[]) => {
    const output: T[] = new Array(items.length);
    await pool(items.map((item, i) => ({ item, i })), 8, async ({ item, i }) => { output[i] = await file(item); });
    return output;
  };
  const stages: CodeData["stages"] = [], transitions: CodeData["transitions"] = [];
  for (const s of input.stages) stages.push({ ...s, files: await mapFiles(s.files) });
  for (const t of input.transitions) transitions.push({ ...t, files: await mapFiles(t.files) });
  return { stages, transitions };
}
async function normalizeEvents(events: BuildEvent[], prefix: string, store: ContentStore) {
  const output: BuildEvent[] = new Array(events.length);
  await pool(events.map((event, i) => ({ event, i })), 8, async ({ event, i }) => {
    const normalized = redacted(event);
    for (const key of ["r", "ri"] as const) if (event[key]) normalized[key] = await store.reference(prefix, "logtexts", event[key]!);
    output[i] = normalized;
  });
  return output;
}
function cardHeader(license?: string) { return license ? `---\nlicense: ${license}\n` : "---\n"; }

export async function migrate(options: MigrationOptions) {
  const { source, out } = options, log = options.log ?? (() => {});
  snapshotId(options.id);
  if (options.license && !/^[a-z0-9.-]+$/.test(options.license)) throw new Error("Invalid license identifier");
  await mkdir(out, { recursive: true });
  const allObjects = await source.list();
  const reader = new MigrationReader(source, allObjects, out, options.seed, log);
  const catalog = await reader.json<PublishedIndex>("index.json");
  const selected = new Set(catalog.tasks.flatMap((task) => task.jobs.map((job) => {
    if (safePath(task.id).includes("/") || safePath(job.id).includes("/")) throw new Error("Catalog IDs must be single path segments");
    return `${task.id}/${job.id}`;
  })));
  if (!selected.size || selected.size !== catalog.tasks.reduce((n, task) => n + task.jobs.length, 0)) throw new Error("Empty/duplicate run selection");
  if (options.expectedRuns !== undefined && selected.size !== options.expectedRuns) throw new Error(`Expected ${options.expectedRuns} cataloged runs, got ${selected.size}; review the new catalog explicitly`);
  const scoped = (objects: SourceObject[]) => objects.filter((o) => o.path === "index.json" || selected.has(o.path.split("/").slice(0, 2).join("/")));
  const sourceFingerprint = fingerprint(scoped(allObjects)), sourceCatalogSha256 = digest(catalog);
  const state = { schemaVersion: 2, id: options.id, sourceFingerprint, sourceCatalogSha256, benchmarkRepository: options.benchmarkRepository, runsRepository: options.runsRepository, license: options.license ?? null };
  const statePath = path.join(out, "source.json");
  if (await exists(statePath)) {
    if (canonical(JSON.parse(await readFile(statePath, "utf8"))) !== canonical(state)) throw new Error("Pinned source/configuration changed. Choose a new output directory/id.");
  } else await writeJson(statePath, state);
  if (await exists(path.join(out, "conversion-report.json"))) { await verifyDirectory(path.join(out, "benchmark")); await verifyDirectory(path.join(out, "runs")); return JSON.parse(await readFile(path.join(out, "conversion-report.json"), "utf8")); }
  const benchmarkRoot = path.join(out, "benchmark"), runsRoot = path.join(out, "runs");
  await mkdir(benchmarkRoot, { recursive: true }); await mkdir(runsRoot, { recursive: true });
  const store = new ContentStore(runsRoot, reader); await store.restore();
  const domains: string[] = [], summaries = new Map<string, { run: RunRecord; stages: StageRecord[]; original: JobSummary }[]>();
  const validation: { domain: string; job: string; stages: number; results: number; passed: number; docsHashes: Record<string, string>; codeHashes: Record<string, string> }[] = [];
  const aggregateWarnings: { domain: string; job: string; publishedScore: number | null; meanStageReward: number | null }[] = [];
  let stagesCount = 0, resultsCount = 0, builderStages = 0, runsWithLogs = 0;
  for (const task of catalog.tasks) {
    const domain = canonicalDomain(task.id);
    if (domains.includes(domain)) throw new Error(`Multiple active variants map to ${domain}; export explicit benchmark versions instead of merging them`);
    domains.push(domain); summaries.set(domain, []);
    let baseline: { docs: DocsData; cases: string; annotations: string; stageNumbers: string; rawDocsHash: string } | undefined;
    for (const [jobIndex, job] of task.jobs.entries()) {
      const prefix = `${task.id}/${job.id}`;
      log(`convert ${domain} ${jobIndex + 1}/${task.jobs.length}: ${job.id}`);
      for (const file of ["meta.json", "code.json", "docs.json", "cases.json", "tickets.json", "passed.json"]) if (!reader.has(`${prefix}/${file}`)) throw new Error(`Cataloged run missing ${file}: ${prefix}`);
      const meta = await reader.json<Meta & Record<string, unknown>>(`${prefix}/meta.json`);
      if (!Array.isArray(meta.stages) || !meta.stages.length || new Set(meta.stages).size !== meta.stages.length || meta.stages.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`Invalid stage IDs in ${prefix}`);
      const originalCode = await reader.json<CodeData>(`${prefix}/code.json`);
      const code = await normalizeCode(originalCode, prefix, store);
      const rawDocs = await reader.json<DocsData>(`${prefix}/docs.json`);
      const docs = baseline?.docs ?? await normalizeDocs(rawDocs, prefix, store);
      // Equal Blob ETags identify the common snapshots; also compare raw document definitions explicitly.
      if (baseline && digest(rawDocs) !== baseline.rawDocsHash) throw new Error(`Benchmark documents vary across ${domain} runs`);
      const cases = await reader.json<CasesData>(`${prefix}/cases.json`), definitions = caseStages(cases, meta);
      const annotation = code.transitions.map((t) => ({ from: t.from, to: t.to, changes: t.docChanges, rules: t.ruleChanges, new_docs: t.newDocs }));
      const caseHash = digest([...definitions.stages]), annotationHash = digest(annotation), stageNumbers = canonical(meta.stages);
      const taskMetadata: BenchmarkTask = { schema_version: 2, id: domain, source_domain: task.id, name: domain === "skyway-air" ? "Skyway Air" : task.name, description: task.description, sources: task.sources,
        stages: meta.stages.map((index) => ({ index, label: meta.scores[String(index)].step || `stage${index}`, kind: domain === "support-agent-knowledge" ? "condition" : "update", docs_mode: domain === "support-agent-knowledge" ? "snapshot" : "delta" })) };
      if (!baseline) {
        baseline = { docs, cases: caseHash, annotations: annotationHash, stageNumbers, rawDocsHash: digest(rawDocs) };
        await writeJson(path.join(benchmarkRoot, domain, "task.json"), taskMetadata);
        let previous: Record<string, Doc> = {};
        for (const [i, n] of meta.stages.entries()) {
          const current = docs[String(n)]; if (!current) throw new Error(`Missing document stage ${n}`);
          const transition = code.transitions.find((t) => t.to === n);
          const deleted = Object.keys(previous).filter((key) => !(key in current));
          const delta = taskMetadata.stages[i].docs_mode === "snapshot" ? current : Object.fromEntries(Object.entries(current).filter(([key, doc]) => !previous[key] || digest(doc) !== digest(previous[key])));
          const change: StageChanges = { changes: transition?.docChanges ?? [], rule_changes: transition?.ruleChanges ?? [], new_docs: transition?.newDocs ?? [], deleted };
          const dir = path.join(benchmarkRoot, domain, "stages", String(n));
          await writeJson(path.join(dir, "docs.json"), delta); await writeJson(path.join(dir, "changes.json"), change); await writeJson(path.join(dir, "cases.json"), definitions.stages.get(n));
          // Rebuild what was just serialized, including deletions/condition replacements, and compare content hashes.
          const saved = JSON.parse(await readFile(path.join(dir, "docs.json"), "utf8"));
          const rebuilt = taskMetadata.stages[i].docs_mode === "snapshot" ? saved : { ...previous, ...saved };
          for (const key of deleted) delete rebuilt[key];
          if (digest(rebuilt) !== digest(current)) throw new Error(`Document round-trip failed ${domain}/${n}`);
          previous = rebuilt;
        }
      } else if (baseline.cases !== caseHash || baseline.annotations !== annotationHash || baseline.stageNumbers !== stageNumbers) throw new Error(`Benchmark cases/changes/stages vary across ${domain} runs; cannot deduplicate silently`);
      const failed = await reader.json<Ticket[]>(`${prefix}/tickets.json`), passed = await reader.json<Ticket[]>(`${prefix}/passed.json`);
      const traces = new Map<string, Ticket>();
      for (const [success, tickets] of [[false, failed], [true, passed]] as const) for (const ticket of tickets) {
        const key = `${ticket.stage}:${ticket.id}`;
        if (traces.has(key)) throw new Error(`Duplicate interaction ${prefix}/${key}`);
        traces.set(key, { ...ticket, passed: success });
      }
      const builds = reader.has(`${prefix}/builds.json`) ? await reader.json<BuildsData>(`${prefix}/builds.json`) : null;
      const run: RunRecord & { source_meta: Record<string, unknown> } = { schema_version: 2, domain, job: job.id, source_domain: task.id, source_job: job.id,
        benchmark: { repository: options.benchmarkRepository, revision: null, inventorySha256: "" }, stages: meta.stages,
        builder: job.builder, bot: job.bot, thinking: job.thinking ?? null, architecture: job.architecture ?? null,
        started: job.started, finished: job.finished, cost: job.cost, tokens: job.tokens, score: job.score, score_aggregation: "published_trial_reward", setup_min: meta.timing?.setup_min ?? null, total_min: meta.timing?.total_min ?? null,
        trial: meta.trial, source_meta: without(meta, ["stages", "scores", "timing"]) };
      const stageRecords: StageRecord[] = [], codeHashes: Record<string, string> = {};
      let runResults = 0, runPassed = 0;
      for (const [i, n] of meta.stages.entries()) {
        const sourceStage = code.stages.find((s) => s.stage === n); if (!sourceStage) throw new Error(`Missing code stage ${prefix}/${n}`);
        const { stage: _stage, ...catalogScore } = job.scores.find((s) => s.stage === n) ?? { stage: n };
        const score = { ...catalogScore, ...meta.scores[String(n)] }, label = score.step || `stage${n}`, timing = meta.timing?.steps[label];
        const logStage = builds?.stages.find((s) => s.index === n || s.step === label);
        const logFile = logStage ? `${prefix}/builds/${logStage.index}.json` : "";
        if (logStage?.format && !reader.has(logFile)) throw new Error(`Missing builder timeline ${logFile}`);
        const available = !!logStage?.format && reader.has(logFile);
        const stage: StageRecord = { stage: n, label, score, builder: redacted(sourceStage.builder), build_min: timing?.build_min ?? null, grade_min: timing?.grade_min ?? null,
          build_log: { available, version: builds?.version ?? 1, harness: builds?.harness ?? null, format: logStage?.format ?? null, summary: logStage ? redacted(logStage.summary) : null } };
        stageRecords.push(stage);
        const outRecords: ResultRecord[] = [];
        for (const definition of definitions.stages.get(n)!) {
          const outcome = definitions.grades.get(n)!.get(definition.id)!, trace = traces.get(`${n}:${definition.id}`);
          if (trace && trace.passed !== outcome.passed) throw new Error(`Trace/grade pass mismatch ${prefix}/${n}/${definition.id}`);
          const base = caseTicketBase(definition), dynamic: Record<string, unknown> = trace ? { ...trace } : {};
          delete dynamic.stage;
          for (const [key, value] of Object.entries(base)) if (key !== "id" && canonical(dynamic[key]) === canonical(value)) delete dynamic[key];
          const record: ResultRecord = { ...dynamic, id: definition.id, passed: outcome.passed, verdict: outcome.verdict ?? null, grading: outcome, trace_available: !!trace };
          if (trace) {
            const restored = { ...base, ...dynamic, stage: n };
            for (const [key, value] of Object.entries(trace)) if (canonical((restored as Record<string, unknown>)[key]) !== canonical(value)) throw new Error(`Interaction round-trip mismatch ${prefix}/${n}/${definition.id}/${key}`);
          }
          outRecords.push(record);
        }
        if (outRecords.length !== score.total || outRecords.filter((r) => r.passed).length !== score.passed) throw new Error(`Score/result parity failed ${prefix}/${n}`);
        const knownIds = new Set(outRecords.map((r) => r.id));
        for (const t of traces.values()) if (t.stage === n && !knownIds.has(t.id)) throw new Error(`Unmatched interaction ${t.id}`);
        const transition = code.transitions.find((t) => t.to === n);
        const stageCode: StageCode = { files: sourceStage.files, knowledge: sourceStage.knowledge, changes: { files: transition?.files ?? [], knowledge: transition?.knowledge ?? [] } };
        codeHashes[String(n)] = digest(stageCode);
        const dir = path.join(runsRoot, domain, job.id, "stages", String(n));
        await writeJson(path.join(dir, "stage.json"), stage); await writeJson(path.join(dir, "results.json"), outRecords); await writeJson(path.join(dir, "code.json"), stageCode);
        if (available) { await writeJson(path.join(dir, "builder.json"), { format: "normalized-events-v1", redacted: true, events: await normalizeEvents(await reader.json<BuildEvent[]>(logFile), prefix, store) }); builderStages++; }
        stagesCount++; runResults += outRecords.length; runPassed += outRecords.filter((r) => r.passed).length;
      }
      if (stageRecords.some((s) => s.build_log.available)) runsWithLogs++;
      const rewards = stageRecords.map((s) => s.score.reward).filter((v): v is number => typeof v === "number");
      const meanStageReward = rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : null;
      if (meanStageReward !== null && job.score !== null && Math.abs(meanStageReward - job.score) > 1e-9) aggregateWarnings.push({ domain, job: job.id, publishedScore: job.score, meanStageReward });
      summaries.get(domain)!.push({ run, stages: stageRecords, original: job });
      validation.push({ domain, job: job.id, stages: meta.stages.length, results: runResults, passed: runPassed, docsHashes: Object.fromEntries(Object.entries(docs).map(([n, d]) => [n, digest(d)])), codeHashes });
      resultsCount += runResults;
      await store.flush();
      await reader.pruneJob(prefix);
    }
  }
  const license = cardHeader(options.license);
  await writeFile(path.join(benchmarkRoot, "README.md"), `${license}---\n\n# C2A benchmark definitions\n\nVersioned documents, stage changes, and grader-defined cases. Knowledge packs are independent condition snapshots.\n\nRuns: https://huggingface.co/datasets/${options.runsRepository}\n\nDocuments contain full text. Each run pins this repository by commit and inventory checksum.\n`);
  const benchmarkInventory = await inventoryDirectory(benchmarkRoot, "benchmark", sourceCatalogSha256);
  for (const domain of domains) {
    const lines = [];
    for (const item of summaries.get(domain)!) {
      item.run.benchmark.inventorySha256 = benchmarkInventory.sha256;
      await writeJson(path.join(runsRoot, domain, item.run.job, "run.json"), item.run);
      const row = makeLeaderboardRow(item.run, item.stages);
      if (Math.abs((row.score ?? 0) - (item.original.score ?? 0)) > 1e-9) throw new Error(`Leaderboard score aggregation changed: ${domain}/${item.run.job}`);
      lines.push(JSON.stringify(row));
    }
    await mkdir(path.join(runsRoot, "data"), { recursive: true }); await writeFile(path.join(runsRoot, "data", `${domain}.jsonl`), lines.join("\n") + "\n");
  }
  const configs = domains.map((domain) => `  - config_name: ${domain}\n    data_files:\n      - split: train\n        path: data/${domain}.jsonl`).join("\n");
  await writeFile(path.join(runsRoot, "README.md"), `${license}configs:\n${configs}\n---\n\n# C2A run results\n\nOne leaderboard row per run, generated from run/stage records. All graded results are preserved, including failed builds and missing traces.\n\nBenchmark definitions: https://huggingface.co/datasets/${options.benchmarkRepository}\n\nCode/log text is deduplicated in content/texts/<prefix>.json using full SHA-256 references. Builder traces are optional normalized, redacted events, not raw original trajectories.\n`);
  await store.pruneUnused();
  await store.flush();
  const current = scoped(await source.list());
  if (fingerprint(current) !== sourceFingerprint) throw new Error("Active Blob catalog/files changed during migration. Do not publish; restart with a new migration ID.");
  const runsInventory = await inventoryDirectory(runsRoot, "runs", sourceCatalogSha256);
  const release = { schemaVersion: 2, provider: "huggingface", domains, benchmark: { repository: options.benchmarkRepository, revision: null, path: "", inventorySha256: benchmarkInventory.sha256 }, runs: { repository: options.runsRepository, revision: null, path: "", inventorySha256: runsInventory.sha256 } };
  await writeJson(path.join(out, "release.json"), release);
  const report = { schemaVersion: 2, status: "validated-local-pending-upload", sourceCatalogSha256, sourceFingerprint, sourceUpdatedAt: catalog.updatedAt,
    runs: selected.size, stages: stagesCount, results: resultsCount, builderLogRuns: runsWithLogs, builderLogStages: builderStages, domains, selectedSourceBytes: scoped(allObjects).reduce((n, o) => n + o.size, 0),
    aggregateWarnings, benchmarkBytes: benchmarkInventory.inventory.files.reduce((n, f) => n + f.size, 0), runsBytes: runsInventory.inventory.files.reduce((n, f) => n + f.size, 0), validation };
  await verifyDirectory(benchmarkRoot, benchmarkInventory.sha256); await verifyDirectory(runsRoot, runsInventory.sha256);
  await writeJson(path.join(out, "conversion-report.json"), report);
  return report;
}
