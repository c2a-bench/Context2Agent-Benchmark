import type { JobSummary, PublishedIndex } from "./data-types";
import type { BuildEvent, BuildsData, CasesData, CaseVersion, CodeData, CodeStage, Doc, DocsData, Meta, StageScore, Ticket, Transition } from "./types";

export type DatasetRef = { repository: string; revision: string; path: string; inventorySha256: string };
export type DatasetRelease = { schemaVersion: 2; provider: "huggingface"; domains: string[]; benchmark: DatasetRef; runs: DatasetRef };
export type TaskStage = { index: number; label: string; kind: "update" | "condition"; docs_mode: "delta" | "snapshot"; files?: string[]; tests_from?: number };
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

/** The bench lists each ticket's pass checks ({check, field, value, list, json}) and keeps a rule's facts on the rule
 *  (rules[].facts); the pages read the grader's form: pass as {check: {field: value}} and a separate rule_facts list.
 *  Older benches already have that form and pass through unchanged. */
type PassCheck = { check: string; field: string | null; value: string[]; list: boolean; json: boolean };
type RuleWithFacts = BenchmarkCase["rules"][number] & { facts?: { id: string; text?: string }[] };
export function caseView(c: BenchmarkCase): BenchmarkCase {
  const raw = c as unknown as { pass: unknown; rules: RuleWithFacts[]; rule_facts?: { id: string; text: string }[] };
  let pass = raw.pass as Record<string, unknown>;
  if (Array.isArray(raw.pass)) {
    pass = {};
    for (const p of raw.pass as PassCheck[]) {
      const vals = p.json ? p.value.map((v) => JSON.parse(v) as unknown) : [...p.value];
      const val = p.list ? vals : vals[0];
      if (p.field == null) pass[p.check] = val;
      else (pass[p.check] = (pass[p.check] as Record<string, unknown> | undefined) ?? {}, (pass[p.check] as Record<string, unknown>)[p.field] = val);
    }
  }
  const rule_facts = raw.rule_facts ?? raw.rules.flatMap((r) => (r.facts ?? []).map((f) => ({ id: f.id, text: f.text ?? r.text })));
  const rules = raw.rules.map(({ facts: _facts, ...r }) => r);
  return { ...c, pass, rules, rule_facts } as BenchmarkCase;
}

/** A stage's rules.json row: the rule's text, the docs that state it (sources) and look-alikes (decoys), quotes. */
export type RuleRow = { id: string; rule: string; sources: string[]; decoys: string[]; evidence: string[]; trap_evidence: string[] };
/** The rule fields a ticket shows, from the stage's rules (tickets store only the rule id and the facts they need). */
export function ruleView(r: RuleRow) {
  return { text: r.rule, real: r.sources, traps: r.decoys, quote: r.evidence[0] ?? "", trap_quote: r.trap_evidence[0] ?? "" };
}
type RuleChangeStub = { id: string; status: string; what?: string | null; diff?: unknown };
export type DocEntry = { born: number; edited: number | null; file?: Record<string, unknown>; text?: string };

// The display text of a doc was first built in Python, so field values that are not text read as Python prints them.
const hex = (c: number, n: number) => c.toString(16).padStart(n, "0");
const NONPRINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;
function pyQuote(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === q || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t";
    else if (NONPRINT.test(ch)) out += c < 0x100 ? "\\x" + hex(c, 2) : c < 0x10000 ? "\\u" + hex(c, 4) : "\\U" + hex(c, 8);
    else out += ch;
  }
  return out + q;
}
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return pyQuote(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyQuote(k)}: ${pyRepr(x)}`).join(", ")}}`;
}
const pyStr = (v: unknown) => (typeof v === "string" ? v : pyRepr(v));
const truthy = (v: unknown) => !(v == null || v === false || v === 0 || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length));
const META = new Set(["title", "author", "status", "last_updated", "created_at", "owner_team", "source_system", "space", "document_type", "dataset_doc_uuid", "title_field_name", "content_field_names", "confidentiality"]);

/** A doc as the pages show it, from its original fields (docs.json `file`): title, status, date, author, readable text. */
export function docView(path: string, e: DocEntry): Doc {
  const name = path.split("/").pop()!;
  if (!e.file) return { title: name, status: "", updated: "", author: "", text: e.text ?? "", source: "api" as Doc["source"], born: e.born, edited: e.edited };
  const raw = e.file;
  let fields = raw.content_field_names as string[] | string | undefined;
  if (typeof fields === "string") fields = JSON.parse(fields.replace(/'/g, '"')) as string[];
  let text = (fields && fields.length ? fields : ["body", "content", "messages", "thread"]).filter((f) => truthy(raw[f])).map((f) => pyStr(raw[f])).join("\n\n");
  if (!text.trim()) text = Object.entries(raw).filter(([k, v]) => !META.has(k) && typeof v === "string" && v.trim()).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v as string}`).join("\n\n");
  const slack = path.startsWith("docs/slack/");
  let updated = (truthy(raw.last_updated) ? raw.last_updated : truthy(raw.created_at) ? raw.created_at : "") as string;
  if (!updated && slack && truthy(raw.last_message_ts)) updated = new Date(parseFloat(String(raw.last_message_ts)) * 1000).toISOString().slice(0, 10);
  return {
    title: (truthy(raw.title) ? raw.title : truthy(raw.channel) ? `#${raw.channel as string}` : name.replace(/\.[^.]*$/, "")) as string,
    status: (truthy(raw.status) ? raw.status : slack ? "slack thread" : "") as string,
    updated, author: ("author" in raw ? raw.author : "") as string,
    text: e.text ?? text, source: slack ? "slack" : "confluence", born: e.born, edited: e.edited,
  };
}

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

/** Long texts are grouped into content/texts/<first TEXT_SHARD characters of their SHA-256>.json (4,096 small files). */
export const TEXT_SHARD = 3;

type Reader = <T>(side: "benchmark" | "runs", file: string) => Promise<T>;
/** The doc index (scripts/build-doc-index.ts): per stage, each doc's byte range in that stage's docs.json and its
 *  listing [start, end, title, status, updated, author, source, born, edited]. */
export type DocIndexRow = [number, number, string, string, string, string, Doc["source"], number | null, number | null];
export type DocIndexFile = { format: 1; revision: string; stages: Record<string, Record<string, DocIndexRow>> };
export function createDatasetLoader(options: { release: DatasetRelease; read: Reader; text: (side: "runs", file: string) => Promise<string>; allowPending?: boolean;
  /** The doc index of a domain, or null; with readRange, docs are listed from it and fetched one at a time. */
  docIndex?: (domain: string) => Promise<DocIndexFile | null>;
  /** Bytes [start, end) of a file, as text (an HTTP range request). */
  readRange?: (side: "benchmark", file: string, start: number, end: number) => Promise<string> }) {
  const { release, read } = options;
  const promises = new Map<string, Promise<unknown>>();
  const memo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!promises.has(key)) { const promise = fn(); promises.set(key, promise); promise.catch(() => promises.delete(key)); }
    return promises.get(key) as Promise<T>;
  };
  const task = (domain: string) => memo(`task:${domain}`, () => read<BenchmarkTask>("benchmark", `${domain}/task.json`));
  const run = (domain: string, job: string) => memo(`run:${domain}/${job}`, async () => {
    void task(domain).catch(() => {}); // every run page needs the task too: fetch both at once
    const value = await read<RunRecord>("runs", `${domain}/${job}/run.json`);
    if (value.domain !== domain || value.job !== job || value.benchmark.repository !== release.benchmark.repository || value.benchmark.inventorySha256 !== release.benchmark.inventorySha256 || (value.benchmark.revision !== release.benchmark.revision && !(options.allowPending && value.benchmark.revision === null))) throw new Error(`Benchmark provenance mismatch for ${domain}/${job}`);
    return value;
  });
  const stage = (domain: string, job: string, n: number) => memo(`stage:${domain}/${job}/${n}`, () => read<StageRecord>("runs", `${domain}/${job}/stages/${n}/stage.json`));
  const stageOf = async (domain: string, n: number) => (await task(domain)).stages.find((s) => s.index === n)!;
  // task.json lists each stage's files; an older bench (no list) always has changes.json and cases.json, no rules.json
  const has = async (domain: string, n: number, file: string) => { const s = await stageOf(domain, n); return s.files ? s.files.includes(file) : file === "changes.json"; };
  /** The rules of stage n: what stages up to n add or change, by id. */
  const rules = (domain: string, n: number) => memo(`rules:${domain}/${n}`, async () => {
    const out = new Map<string, RuleRow>();
    // every stage's file at once, then applied in stage order
    const files = await Promise.all((await task(domain)).stages.filter((s) => s.index <= n).map(async (s) =>
      (await has(domain, s.index, "rules.json")) ? read<RuleRow[]>("benchmark", `${domain}/stages/${s.index}/rules.json`) : []));
    for (const rows of files) for (const r of rows) out.set(r.id, r);
    return out;
  });
  const definitions = (domain: string, n: number) => memo(`cases:${domain}/${n}`, async () => {
    const s = await stageOf(domain, n);
    const [byId, rows] = await Promise.all([rules(domain, n), read<BenchmarkCase[]>("benchmark", s.files ? `${domain}/stages/${s.tests_from ?? n}/test.json` : `${domain}/stages/${n}/cases.json`)]);
    return rows.map((c) => caseView({ ...c, rules: c.rules.map((r) => byId.has(r.id) ? { ...ruleView(byId.get(r.id)!), ...r } : r) } as BenchmarkCase));
  });
  const results = (domain: string, job: string, n: number) => memo(`results:${domain}/${job}/${n}`, () => read<ResultRecord[]>("runs", `${domain}/${job}/stages/${n}/results.json`));
  const EMPTY: StageChanges = { changes: [], rule_changes: [], new_docs: [], deleted: [] };
  const stageChanges = (domain: string, n: number) => memo(`changes-file:${domain}/${n}`, async () =>
    (await has(domain, n, "changes.json")) ? { ...EMPTY, ...await read<StageChanges>("benchmark", `${domain}/stages/${n}/changes.json`) } : EMPTY);
  /** A stage's changes; each changed rule's text, docs and quotes come from the stage's rules and docs. */
  const changes = (domain: string, n: number) => memo(`changes:${domain}/${n}`, async (): Promise<StageChanges> => {
    const c = await stageChanges(domain, n);
    if (!c.rule_changes.length) return c;
    const [byId, d] = await Promise.all([rules(domain, n), docList(domain)]);
    const at = d[String(n)] ?? {};
    const ref = (path: string) => ({ path, title: at[path]?.title, status: at[path]?.status, updated: at[path]?.updated });
    const rule_changes = (c.rule_changes as unknown as RuleChangeStub[]).map((stub) => {
      const r = byId.get(stub.id);
      if (!r) return stub;
      const v = ruleView(r);
      return { id: stub.id, status: stub.status, text: v.text, diff: stub.diff ?? null, what: stub.what, sources: r.sources.map(ref), traps: r.decoys.map(ref), quote: v.quote, trapQuote: v.trap_quote };
    }) as unknown as StageChanges["rule_changes"];
    return { ...c, rule_changes };
  });
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
      const [entries, change] = await Promise.all([read<Record<string, DocEntry | Doc>>("benchmark", `${domain}/stages/${s.index}/docs.json`), stageChanges(domain, s.index)]);
      const delta = Object.fromEntries(Object.entries(entries).map(([p, e]) => [p, "born" in e && !("title" in e) ? docView(p, e as DocEntry) : e as Doc]));
      effective = s.docs_mode === "snapshot" ? { ...delta } : { ...effective, ...delta };
      for (const key of change.deleted) delete effective[key];
      output[String(s.index)] = effective;
    }
    return output;
  });
  const docIndex = (domain: string) => memo(`docindex:${domain}`, async () => (options.docIndex && options.readRange ? options.docIndex(domain).catch(() => null) : null));
  /** Every doc of every stage, as docs() but without the texts: from the doc index when there is one (a doc's text is
   *  fetched by doc() when it is opened), else docs() itself. */
  const docList = (domain: string) => memo(`doclist:${domain}`, async (): Promise<DocsData> => {
    const idx = await docIndex(domain);
    if (!idx) return docs(domain);
    let effective: Record<string, Doc> = {};
    const output: DocsData = {};
    const stages = (await task(domain)).stages;
    const changeOf = await Promise.all(stages.map((s) => stageChanges(domain, s.index)));
    for (const [i, s] of stages.entries()) {
      const change = changeOf[i];
      const delta = Object.fromEntries(Object.entries(idx.stages[String(s.index)] ?? {}).map(([p, [start, end, title, status, updated, author, source, born, edited]]) =>
        [p, { title, status, updated, author, source, born: born ?? 0, edited, text: "", at: { stage: s.index, start, end } } satisfies Doc]));
      effective = s.docs_mode === "snapshot" ? { ...delta } : { ...effective, ...delta };
      for (const key of change.deleted) delete effective[key];
      output[String(s.index)] = effective;
    }
    return output;
  });
  /** One doc as the builder saw it at stage n, with its text: only that doc's bytes when the index has it. */
  const doc = (domain: string, n: number, p: string) => memo(`doc:${domain}/${n}/${p}`, async (): Promise<Doc | null> => {
    const row = (await docList(domain))[String(n)]?.[p];
    if (!row?.at) return row ?? null;
    const e = JSON.parse(await options.readRange!("benchmark", `${domain}/stages/${row.at.stage}/docs.json`, row.at.start, row.at.end)) as DocEntry | Doc;
    return "born" in e && !("title" in e) ? docView(p, e as DocEntry) : (e as Doc);
  });
  const code = (domain: string, job: string) => memo(`code:${domain}/${job}`, async (): Promise<CodeData> => {
    const r = await run(domain, job), stages: CodeData["stages"] = [], transitions: Transition[] = [];
    const loaded = await Promise.all(r.stages.map((n) => Promise.all([stage(domain, job, n), read<StageCode>("runs", `${domain}/${job}/stages/${n}/code.json`), changes(domain, n)])));
    for (let i = 0; i < r.stages.length; i++) {
      const n = r.stages[i];
      const [s, c, b] = loaded[i];
      stages.push({ stage: n, score: { passed: s.score.passed, total: s.score.total }, builder: s.builder, files: c.files, knowledge: c.knowledge });
      if (i) transitions.push({ from: r.stages[i - 1], to: n, docChanges: b.changes, newDocs: b.new_docs, ruleChanges: b.rule_changes, files: c.changes.files, knowledge: c.changes.knowledge });
    }
    return { stages, transitions };
  });
  const cases = (domain: string, job: string) => memo(`cases:${domain}/${job}`, async (): Promise<CasesData> => {
    const r = await run(domain, job), items = new Map<string, CasesData["tickets"][number]>();
    const labels: string[] = [];
    const loaded = await Promise.all(r.stages.map((n) => Promise.all([stage(domain, job, n), results(domain, job, n), definitions(domain, n)])));
    for (const [i, n] of r.stages.entries()) {
      const [s, rows, defs] = loaded[i]; labels.push(s.label);
      const outcome = new Map(rows.map((row) => [row.id, row.grading]));
      for (const c of defs) {
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
    const shard = await read<Record<string, string>>("runs", `content/texts/${ref.slice(0, TEXT_SHARD)}.json`);
    if (typeof shard[ref] !== "string") throw new Error(`Missing content ${ref}`);
    return shard[ref];
  });
  return { index, task, run, stage, definitions, results, meta, interactions, docs, docList, doc, changes, code, cases, builds, events, text };
}
