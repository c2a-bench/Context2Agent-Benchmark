#!/usr/bin/env node
/**
 * Publish Harbor runs to Vercel Blob for the production viewer.
 *
 *   cd viewer
 *   # one run:
 *   npm run publish -- --task redwood-inference --job 2026-09-19__15-40-57
 *   # sync every run listed in publish.json (replaces the remote catalog):
 *   npm run publish -- --sync
 *   # put every task's runs back in start-time order (newest first):
 *   npm run publish -- --sort
 *   # drop a run from the catalog (keeps Blob objects unless --delete):
 *   npm run publish -- --remove --task redwood-inference --job …
 *
 * Needs BLOB_READ_WRITE_TOKEN. This only publishes source data to Blob.
 * Convert with migrate:blob, publish a verified benchmark/runs pair; the Pages frontend reads HF.
 */
import { del, list, put } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLogs,
  ensure,
  getCases,
  jobSummary,
  resolve,
  taskInfo,
} from "../server/data-local";
import type { PublishedIndex } from "../src/lib/data-types";
import { JOB_FILES, runKey } from "../src/lib/data-types";
import { failureSummary } from "../src/lib/failure-types";
import type { Ticket } from "../src/lib/types";

// Passed tickets (the Interactions page), uploaded when the replay builder wrote it; the Test cases tab's tickets
// (scripts/case_data.py).
const OPTIONAL_JOB_FILES = ["passed.json", "cases.json"] as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = path.resolve(__dirname, "..");
const REPO = path.resolve(VIEWER, "..");
process.chdir(VIEWER);
if (!process.env.REPO_ROOT) process.env.REPO_ROOT = REPO;

const PREFIX = (process.env.BLOB_PREFIX || "observe-bench").replace(/^\/|\/$/g, "");
const PUT_OPTS = { access: "public" as const, addRandomSuffix: false, allowOverwrite: true };
const SHARD_UPLOADS = Math.max(1, Math.floor(Number(process.env.SHARD_UPLOADS)) || 12); // at least one upload at a time

function usage() {
  console.error(`Usage:
  npm run publish -- --task <task> --job <id>     upload one run and merge into index
  npm run publish -- --task <task> --job <id> --as <env> [--as-name "<name>"]
                                                  build the run from <task>, publish it under environment <env>
                                                  (its own card and leaderboard, e.g. skyway-arch-regraded)
  npm run publish -- --sync                       publish all runs in publish.json
  npm run publish -- --sort                       put every task's runs in start-time order, newest first
  npm run publish -- --task … --job … --logs-only  upload only the run's builder logs (no catalog write)
  npm run publish -- --remove --task … --job …    remove run from index
  npm run publish -- --remove --task … --job … --delete   also delete Blob objects

Env: BLOB_READ_WRITE_TOKEN (required), BLOB_PREFIX (default observe-bench), JOBS_DIR (optional)`);
  process.exit(1);
}

/** An environment id is the part of a run's key before its first dot (parseRunKey), so it cannot hold a dot. */
function checkEnvId(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`--as ${JSON.stringify(id)}: use letters, digits, _ and - only (no dots)`);
  return id;
}

function parseArgs(argv: string[]) {
  const out: { task?: string; job?: string; as?: string; asName?: string; sync?: boolean; remove?: boolean; delete?: boolean; sort?: boolean; logsOnly?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sync") out.sync = true;
    else if (a === "--sort") out.sort = true;
    else if (a === "--remove") out.remove = true;
    else if (a === "--delete") out.delete = true;
    else if (a === "--logs-only") out.logsOnly = true;
    else if (a === "--task") out.task = argv[++i];
    else if (a === "--job") out.job = argv[++i];
    else if (a === "--as") out.as = argv[++i];
    else if (a === "--as-name") out.asName = argv[++i];
    else if (a === "-h" || a === "--help") usage();
    else {
      console.error(`unknown arg: ${a}`);
      usage();
    }
  }
  return out;
}

// Show help before requiring credentials.
if (process.argv.includes("-h") || process.argv.includes("--help")) usage();

/** A run, optionally filed under another environment (as publish-run.ts --as / --as-name). */
type PublishFile = { runs: { task: string; job: string; as?: string; asName?: string }[] };

function loadPublishFile(): PublishFile {
  const file = path.join(VIEWER, "publish.json");
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as PublishFile;
}

async function fetchIndex(): Promise<PublishedIndex> {
  const empty: PublishedIndex = { updatedAt: new Date(0).toISOString(), prefix: PREFIX, tasks: [] };
  const listed = await list({ prefix: `${PREFIX}/index.json` });
  const hit = listed.blobs.find((b) => b.pathname === `${PREFIX}/index.json`);
  if (!hit) return empty;
  // Reads can return an older copy for a while after a write, and writing a stale catalog back
  // drops the runs published since. Only accept the copy written when the blob was last uploaded.
  const sep = hit.downloadUrl.includes("?") ? "&" : "?";
  const written = new Date(hit.uploadedAt).getTime();
  for (let attempt = 1; attempt <= 20; attempt++) {
    const res = await fetch(`${hit.downloadUrl}${sep}t=${Date.now()}`, { cache: "no-store" });
    // Never fall back to an empty catalog when one exists: writing it back would remove every run.
    if (!res.ok) throw new Error(`could not read ${hit.pathname}: HTTP ${res.status}`);
    const index = (await res.json()) as PublishedIndex;
    // The copy is the current one when its ETag is the listed blob's (the stamp in it can be far from uploadedAt
    // when the upload itself was slow, which used to stall every later publish); else fall back to the stamp.
    const etag = res.headers.get("etag")?.replace(/^W\//, "");
    if (etag && hit.etag && etag === hit.etag) return index;
    if (Math.abs(new Date(index.updatedAt).getTime() - written) < 10_000) return index;
    console.log(`  catalog copy is older than the last upload; retrying (${attempt})`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`${hit.pathname}: could not read the current catalog; not writing over it`);
}

async function putJson(pathname: string, value: unknown) {
  const body = JSON.stringify(value);
  const result = await put(pathname, body, {
    ...PUT_OPTS,
    contentType: "application/json",
    // The catalog changes on every publish; keep its CDN copy short-lived (60s is the minimum).
    cacheControlMaxAge: 60,
  });
  return result;
}

function baseFromUrl(fileUrl: string, pathname: string) {
  // https://….blob.vercel-storage.com/observe-bench/index.json → …/observe-bench
  if (pathname.endsWith("/index.json") && fileUrl.endsWith("/index.json")) {
    return fileUrl.slice(0, -"/index.json".length);
  }
  if (fileUrl.endsWith(`/${pathname}`)) return fileUrl.slice(0, -(pathname.length + 1));
  const i = fileUrl.lastIndexOf(`/${PREFIX}/`);
  if (i >= 0) return fileUrl.slice(0, i + 1 + PREFIX.length);
  throw new Error(`could not derive DATA_BASE_URL from ${fileUrl}`);
}

/** `as`: publish the run under another environment id (built from `task`'s files, filed under `as.id`). */
async function uploadRun(task: string, job: string, as?: { id: string; name?: string }) {
  const key = runKey(task, job);
  const env = as?.id ?? task; // the environment the run is filed under on the site
  const paths = resolve(key);
  console.log(`replaying ${key} from ${paths.dir}`);
  const cache = ensure(key);
  try {
    getCases(key); // writes cases.json next to the run's other files
  } catch (e) {
    console.log(`  no cases.json (${String(e).slice(0, 120)})`);
  }
  const built = jobSummary(task, job);
  if (!built) throw new Error(`could not build summary for ${key}`);
  // publishedAt: the version in the run's file addresses; key: the run's address under its environment
  const summary = { ...built, key: runKey(env, job), publishedAt: new Date().toISOString() };
  const source = taskInfo(task);
  if (!source) throw new Error(`unknown task ${task} (need tasks/${task}/task.toml)`);
  const info = as ? { ...source, id: as.id, name: as.name ?? `${source.name} (${as.id})` } : source;

  // The landing failure chart. tickets.json is too big to ship to that page, so put the rollup in meta.json, which it already loads.
  const tickets = JSON.parse(fs.readFileSync(path.join(cache, "tickets.json"), "utf8")) as Ticket[];
  const total = built.scores.reduce((a, s) => a + (s.total ?? 0), 0);
  const failed = total - built.scores.reduce((a, s) => a + (s.passed ?? 0), 0);
  const metaPath = path.join(cache, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath, "utf8")), failure_summary: failureSummary(tickets, failed, total) }));

  for (const file of JOB_FILES) {
    const full = path.join(cache, file);
    if (!fs.existsSync(full)) throw new Error(`missing ${full}`);
    const pathname = `${PREFIX}/${env}/${job}/${file}`;
    const raw = fs.readFileSync(full);
    const { url } = await put(pathname, raw, {
      ...PUT_OPTS,
      contentType: "application/json",
    });
    console.log(`  put ${pathname} (${(raw.length / 1024).toFixed(0)} KB) → ${url}`);
  }
  for (const file of OPTIONAL_JOB_FILES) {
    const full = path.join(cache, file);
    if (!fs.existsSync(full)) continue;
    const pathname = `${PREFIX}/${env}/${job}/${file}`;
    const raw = fs.readFileSync(full);
    const { url } = await put(pathname, raw, { ...PUT_OPTS, contentType: "application/json" });
    console.log(`  put ${pathname} (${(raw.length / 1024).toFixed(0)} KB) → ${url}`);
  }
  // Runs built with text shards (texts/<2 hex>.json): the viewer fetches a doc's or file's text from its shard.
  const texts = path.join(cache, "texts");
  if (fs.existsSync(texts)) {
    const shards = fs.readdirSync(texts).filter((f) => /^[0-9a-f]{2}\.json$/.test(f));
    // Up to SHARD_UPLOADS at a time (one by one, a big run's 256 shards took minutes), each tried up to 3 times.
    const queue = [...shards];
    const upload = async (f: string) => {
      for (let attempt = 1; ; attempt++) {
        try {
          await put(`${PREFIX}/${env}/${job}/texts/${f}`, fs.readFileSync(path.join(texts, f)), { ...PUT_OPTS, contentType: "application/json" });
          return;
        } catch (e) {
          if (attempt >= 3) throw new Error(`texts/${f}: ${e}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SHARD_UPLOADS, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await upload(f);
    }));
    console.log(`  put ${PREFIX}/${env}/${job}/texts/ (${shards.length} shards)`);
  }
  await uploadLogs(task, job, env);
  return { summary, info };
}

/** The builder's logs (the Build tab): builds.json, each step's timeline builds/<i>.json, and the long texts in
 *  logtexts/<2 hex>.json, built from the run's own logs. A run without builder logs has none, and the tab says so.
 *  Writes no catalog entry: --logs-only uses it alone, so runs can get their logs in parallel. */
async function uploadLogs(task: string, job: string, env: string) {
  const key = `${task}.${job}`;
  const cache = buildLogs(key);
  const logFiles = [
    ...(fs.existsSync(path.join(cache, "builds.json")) ? ["builds.json"] : []),
    ...["builds", "logtexts"].flatMap((d) =>
      fs.existsSync(path.join(cache, d)) ? fs.readdirSync(path.join(cache, d)).filter((f) => f.endsWith(".json")).map((f) => `${d}/${f}`) : []),
  ];
  if (!logFiles.length) {
    console.log(`  ${task}.${job}: no builder logs`);
    return 0;
  }
  const queue = [...logFiles];
  const upload = async (f: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await put(`${PREFIX}/${env}/${job}/${f}`, fs.readFileSync(path.join(cache, f)), { ...PUT_OPTS, contentType: "application/json" });
        return;
      } catch (e) {
        if (attempt >= 3) throw new Error(`${f}: ${e}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHARD_UPLOADS, queue.length) }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) await upload(f);
  }));
  console.log(`  put ${PREFIX}/${env}/${job}/ builder logs (${logFiles.length} files)`);
  return logFiles.length;
}

/** Newest first by start time, so publishing an old run again does not move it to the top. A relabel shares its
 *  run's start time and sorts first ("…-relabel" > "…"). */
function sortJobs<J extends { id: string; started?: string | null }>(jobs: J[]): J[] {
  return [...jobs].sort((a, b) => (b.started ?? "").localeCompare(a.started ?? "") || b.id.localeCompare(a.id));
}

function upsertIndex(
  index: PublishedIndex,
  info: { id: string; name: string; description: string; sources: { label: string; url: string }[] },
  summary: PublishedIndex["tasks"][0]["jobs"][0],
  replaceOnly = false,
): PublishedIndex {
  const tasks = [...index.tasks];
  let t = tasks.find((x) => x.id === info.id);
  if (!t) {
    t = { id: info.id, name: info.name, description: info.description, sources: info.sources, jobs: [] };
    tasks.push(t);
  } else {
    t.name = info.name;
    t.description = info.description;
    t.sources = info.sources;
  }
  if (replaceOnly) {
    t.jobs = [summary];
  } else {
    t.jobs = sortJobs([summary, ...t.jobs.filter((j) => j.id !== summary.id)]);
  }
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  return { updatedAt: new Date().toISOString(), prefix: PREFIX, tasks };
}

async function writeIndex(index: PublishedIndex) {
  const pathname = `${PREFIX}/index.json`;
  const { url } = await putJson(pathname, index);
  const base = baseFromUrl(url, pathname);
  console.log(`\nindex → ${url}`);
  console.log(`Blob source prefix:\n  ${base}\nConvert with npm run migrate:blob, publish the verified benchmark/runs datasets, then approve the Pages release.`);
  return base;
}

async function removeRun(task: string, job: string, alsoDelete: boolean) {
  const index = await fetchIndex();
  const tasks = index.tasks
    .map((t) => (t.id === task ? { ...t, jobs: t.jobs.filter((j) => j.id !== job) } : t))
    .filter((t) => t.jobs.length > 0);
  await writeIndex({ updatedAt: new Date().toISOString(), prefix: PREFIX, tasks });
  console.log(`removed ${task}.${job} from index`);
  if (alsoDelete) {
    for (const file of [...JOB_FILES, ...OPTIONAL_JOB_FILES]) {
      const pathname = `${PREFIX}/${task}/${job}/${file}`;
      try {
        await del(pathname);
        console.log(`  deleted ${pathname}`);
      } catch (e) {
        console.warn(`  skip delete ${pathname}: ${e}`);
      }
    }
    // The run's text shards (texts/<2 hex>.json) and builder logs (builds.json, builds/, logtexts/), when published.
    for (const prefix of ["texts/", "builds", "logtexts/"].map((p) => `${PREFIX}/${task}/${job}/${p}`)) {
      let cursor: string | undefined;
      let n = 0;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        if (page.blobs.length) {
          await del(page.blobs.map((b) => b.url));
          n += page.blobs.length;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      if (n) console.log(`  deleted ${prefix}* (${n} files)`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN is required (Vercel → Storage → Blob)");
    process.exit(1);
  }

  if (args.sort) {
    // Put every task's runs back in start-time order (catalogs written before publishes kept that order).
    const index = await fetchIndex();
    await writeIndex({ ...index, tasks: index.tasks.map((t) => ({ ...t, jobs: sortJobs(t.jobs) })), updatedAt: new Date().toISOString() });
    console.log("sorted every task's runs, newest first");
    return;
  }

  if (args.remove) {
    if (!args.task || !args.job) usage();
    await removeRun(args.task!, args.job!, !!args.delete);
    return;
  }

  if (args.sync) {
    const file = loadPublishFile();
    if (!file.runs?.length) throw new Error("publish.json has no runs");
    let index: PublishedIndex = { updatedAt: new Date().toISOString(), prefix: PREFIX, tasks: [] };
    for (const run of file.runs) {
      const { summary, info } = await uploadRun(run.task, run.job, run.as ? { id: checkEnvId(run.as), name: run.asName } : undefined);
      index = upsertIndex(index, info, summary, false);
    }
    // Keep only synced runs in the catalog.
    const wanted = new Set(file.runs.map((r) => runKey(r.as ?? r.task, r.job)));
    index = {
      ...index,
      tasks: index.tasks
        .map((t) => ({ ...t, jobs: t.jobs.filter((j) => wanted.has(j.key)) }))
        .filter((t) => t.jobs.length > 0),
      updatedAt: new Date().toISOString(),
    };
    await writeIndex(index);
    console.log(`\nsynced ${file.runs.length} run(s)`);
    return;
  }

  if (!args.task || !args.job) usage();
  const task = args.task!;
  const job = args.job!;
  if (args.logsOnly) {
    // Only the builder logs of a run already published: no run files, no catalog write (safe in parallel).
    await uploadLogs(task, job, task);
    console.log(`\nuploaded the builder logs of ${task}.${job}`);
    return;
  }
  const current = await fetchIndex();
  // Without --as-name, an environment published before keeps its name; a new one gets "<task name> (<env>)".
  const as = args.as
    ? { id: checkEnvId(args.as), name: args.asName ?? current.tasks.find((t) => t.id === args.as)?.name }
    : undefined;
  const { summary, info } = await uploadRun(task, job, as);
  const index = upsertIndex(current, info, summary, false);
  await writeIndex(index);
  console.log(`\npublished ${summary.key}${as ? ` (built from ${task}.${job})` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
