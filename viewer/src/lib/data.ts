import type { BuildEvent, BuildsData, CasesData, CodeData, Doc, DocsData, Meta, Ticket } from "./types";
import type { JobSummary, PublishedIndex, TaskSummary } from "./data-types";
import { parseRunKey } from "./data-types";
import { track } from "./loading";
import { canonicalDomain, createDatasetLoader, type DatasetRelease } from "./dataset-v2";

export type { JobSummary, TaskSummary, PublishedIndex } from "./data-types";
export { runKey, parseRunKey, DEFAULT_TASK, OLD_NAMES, JOB_FILES } from "./data-types";

/** Published mode reads a public, commit-pinned Hugging Face dataset; local dev reads jobs via /api. */
export function isPublishedMode() {
  const mode = import.meta.env.VITE_DATA_MODE;
  if (mode === "published") return true;
  if (mode === "local") return false;
  return import.meta.env.PROD;
}

let dataset: ReturnType<typeof createDatasetLoader> | null = null;
function publishedDataset() {
  if (!dataset) {
    const config = JSON.parse(import.meta.env.VITE_DATA_RELEASE || "null") as { release: DatasetRelease; urls: { benchmark: string; runs: string } } | null;
    if (!config || config.release.schemaVersion !== 2) throw new Error("The two-repository dataset release is not configured");
    const url = (side: "benchmark" | "runs", file: string) => `${config.urls[side]}/${file}`;
    dataset = createDatasetLoader({ release: config.release,
      read: <T>(side: "benchmark" | "runs", file: string) => {
        const target = url(side, file);
        return memo(target, () => track((BIG_FILE.test(target) ? viaWorker(target) : fetchJson(target)) as Promise<T>));
      },
      text: (side, file) => memo(url(side, file), () => track(fetch(url(side, file)).then((res) => { if (!res.ok) throw new Error(`Failed to load ${file}`); return res.text(); }))),
    });
  }
  return dataset;
}

// One promise per file, so components can read it with React's use() and re-renders share it.
const cache = new Map<string, Promise<unknown>>();

function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (!hit) {
    hit = load();
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit as Promise<T>;
}

// A run's big files are fetched and parsed in a worker (lib/json-worker.ts), so the page keeps responding.
const BIG_FILE = /\/(code|docs|tickets|passed|cases|results|builder)\.json(\?|$)|\/(texts|logtexts)\/[0-9a-f]{2}\.json(\?|$)|\/builds\/\d+\.json(\?|$)/;
let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

function viaWorker(url: string): Promise<unknown> {
  if (typeof Worker === "undefined") return fetchJson(url);
  if (!worker) {
    worker = new Worker(new URL("./json-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; data?: unknown; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) w.fail(new Error(e.data.error));
      else w.ok(e.data.data);
    };
  }
  const id = nextId++;
  // The worker resolves the URL against its own location: give it an absolute one.
  const abs = new URL(url, window.location.href).href;
  return new Promise((ok, fail) => {
    waiting.set(id, { ok, fail });
    worker!.postMessage({ id, url: abs });
  });
}

function fetchJson(url: string): Promise<unknown> {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
    return res.json();
  });
}

function remoteJson<T>(rel: string): Promise<T> {
  const url = `/api/${rel.replace(/^\//, "")}`;
  return memo(url, () => track((BIG_FILE.test(url) ? viaWorker(url) : fetchJson(url)) as Promise<T>));
}

// Only local catalogs refresh while jobs change. A deployed HF commit is immutable until a new Pages build.
const CATALOG_TTL_MS = 60_000;
type Settled<T> = Promise<T> & { status?: string; value?: T };
let catalog: { at: number; promise: Settled<PublishedIndex>; refreshing: boolean } | null = null;

function fetchIndex(): Promise<PublishedIndex> {
  if (isPublishedMode()) return track(publishedDataset().index());
  const url = "/api/index.json";
  return track(
    fetch(url, { cache: isPublishedMode() ? "default" : "no-cache" }).then((res) => {
      if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
      return res.json() as Promise<PublishedIndex>;
    }),
  );
}

function resolved<T>(value: T): Settled<T> {
  const p: Settled<T> = Promise.resolve(value);
  p.status = "fulfilled";
  p.value = value;
  return p;
}

function loadIndex(): Settled<PublishedIndex> {
  if (!catalog) {
    const promise: Settled<PublishedIndex> = fetchIndex();
    promise.catch(() => (catalog = null));
    catalog = { at: Date.now(), promise, refreshing: false };
  } else if (!isPublishedMode() && Date.now() - catalog.at >= CATALOG_TTL_MS && !catalog.refreshing) {
    const stale = catalog;
    stale.refreshing = true;
    fetchIndex().then(
      (index) => (catalog = { at: Date.now(), promise: resolved(index), refreshing: false }),
      () => (stale.refreshing = false),
    );
  }
  return catalog.promise;
}

// What a page derives from the catalog (environments, a task's runs), once per catalog, so it follows a refresh.
const derived = new WeakMap<Promise<PublishedIndex>, Map<string, Promise<unknown>>>();

function fromIndex<T>(key: string, f: (index: PublishedIndex) => T): Promise<T> {
  const index = loadIndex();
  let byKey = derived.get(index);
  if (!byKey) derived.set(index, (byKey = new Map()));
  let p = byKey.get(key) as Promise<T> | undefined;
  if (!p) {
    p = index.status === "fulfilled" ? resolved(f(index.value as PublishedIndex)) : index.then(f);
    byKey.set(key, p);
  }
  return p;
}

export const listTasks = (): Promise<TaskSummary[]> =>
  fromIndex("tasks", (index) => index.tasks
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      sources: t.sources,
      runs: t.jobs.length,
      latest: t.jobs[0]?.id ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)));

/** A task's runs, newest first by start time (the catalog is in publish order). A relabel shares its run's start
 *  time and sorts first ("…-relabel" > "…"), so it stands for that run. */
export const listJobs = (task: string): Promise<JobSummary[]> =>
  fromIndex(`jobs:${task}`, (index) =>
    [...(index.tasks.find((t) => t.id === (isPublishedMode() ? canonicalDomain(task) : task))?.jobs ?? [])].sort(
      (a, b) => (b.started ?? "").localeCompare(a.started ?? "") || b.id.localeCompare(a.id),
    ));

/** Published URLs already contain the immutable HF commit. No moving branch or cache-busting query is needed. */
function runFile<T>(key: string, file: string): Promise<T> {
  const parsed = parseRunKey(key), job = parsed.job;
  const task = isPublishedMode() ? canonicalDomain(parsed.task) : parsed.task;
  if (!isPublishedMode()) return remoteJson<T>(`${task}/${job}/${file}`);
  const loader = publishedDataset();
  const read = (): Promise<unknown> => {
    switch (file) {
      case "meta.json": return loader.meta(task, job);
      case "code.json": return loader.code(task, job);
      case "docs.json": return loader.docs(task);
      case "cases.json": return loader.cases(task, job);
      case "tickets.json": return loader.interactions(task, job).then((rows) => rows.filter((r) => !r.passed));
      case "passed.json": return loader.interactions(task, job).then((rows) => rows.filter((r) => r.passed));
      case "builds.json": return loader.builds(task, job);
      default: {
        const match = file.match(/^builds\/(\d+)\.json$/);
        if (match) return loader.events(task, job, Number(match[1]));
        throw new Error(`Unsupported replay request ${file}`);
      }
    }
  };
  return memo(`v2:${task}/${job}/${file}`, () => track(read()) as Promise<T>);
}

export const getMeta = (key: string) => runFile<Meta>(key, "meta.json");
// The runtime agent is "the agent" on screen; the grader's own text still says "bot". Only prose fields are reworded,
// never keys or values the viewer matches on (side "bot", party "Bot", labels, ids).
const PROSE = new Set(["title", "test", "matters", "brief", "line", "note", "text", "detail", "why", "reason", "what", "failures"]);
const agentWords = (s: string) =>
  s.replace(/\ba bot\b/g, "an agent").replace(/\bA bot\b/g, "An agent").replace(/\bbots\b/g, "agents").replace(/\bbot\b/g, "agent").replace(/\bBot\b/g, "Agent");
function reword(x: unknown, prose = false): unknown {
  if (typeof x === "string") return prose ? agentWords(x) : x;
  if (Array.isArray(x)) return x.map((v) => reword(v, prose));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, reword(v, PROSE.has(k))]));
  return x;
}
const ticketFile = (key: string, file: string) =>
  memo(`reworded:${key}:${file}`, async () => reword(await runFile<Ticket[]>(key, file)) as Ticket[]);

export const getTickets = (key: string) => ticketFile(key, "tickets.json");
export const getCode = (key: string) => runFile<CodeData>(key, "code.json");
export const getDocs = (key: string) => runFile<DocsData>(key, "docs.json");
/** Every ticket of the run's task as the grader defines it (scripts/case_data.py), with this run's result. */
export const getCases = (key: string) => memo(`cases:${key}`, () => runFile<CasesData>(key, "cases.json").catch((error) => { if (isPublishedMode()) throw error; return null; }));
/** Every ticket of a run, failed then passed. Runs published before passed.json existed have only their failed tickets. */
export const getInteractions = (key: string): Promise<Ticket[]> =>
  memo(`interactions:${key}`, async () => {
    const [failed, passed] = await Promise.all([getTickets(key), ticketFile(key, "passed.json").catch(() => [] as Ticket[])]);
    return [...failed.map((t) => ({ ...t, passed: false })), ...passed.map((t) => ({ ...t, passed: true }))];
  });

/** A text by its reference: runs built with texts/ shards keep docs' and bot files' texts there, and the viewer loads
 *  only the shard (texts/<first 2 characters>.json) of the text it shows. */
const textShard = (key: string, shard: string) =>
  memo(`texts:${key}:${shard}`, () => runFile<Record<string, string>>(key, `texts/${shard}.json`));
export const getText = (key: string, ref: string | null | undefined): Promise<string> =>
  ref ? memo(`text:${key}:${ref}`, () => isPublishedMode() ? publishedDataset().text(ref) : textShard(key, ref.slice(0, 2)).then((s) => s[ref] ?? "")) : Promise.resolve("");

/** The builder's logs (scripts/build_logs.py): a summary per step, null for runs built before the logs existed. */
export const getBuilds = (key: string) => memo(`builds:${key}`, () => runFile<BuildsData>(key, "builds.json").catch((error) => { if (isPublishedMode()) throw error; return null; }));
/** One step's timeline, fetched when that step is opened. */
export const getBuildEvents = (key: string, index: number) =>
  memo(`buildevents:${key}:${index}`, () => runFile<BuildEvent[]>(key, `builds/${index}.json`));
/** A long text from the builder's logs, by reference (logtexts/<first 2 characters>.json). */
export const getLogText = (key: string, ref: string): Promise<string> =>
  memo(`logtext:${key}:${ref}`, () => isPublishedMode() ? publishedDataset().text(ref) : runFile<Record<string, string>>(key, `logtexts/${ref.slice(0, 2)}.json`).then((s) => s[ref] ?? ""));

/** One doc as the builder saw it in that stage, or null (its text from the shards when the run keeps texts there). */
export const getDoc = (key: string, stage: number, path: string): Promise<Doc | null> =>
  memo(`doc:${key}:${stage}:${path}`, () =>
    getDocs(key).then(async (d) => {
      const doc = d[String(stage)]?.[path] ?? null;
      return doc && doc.text == null && doc.ref ? { ...doc, text: await getText(key, doc.ref) } : doc;
    }));
