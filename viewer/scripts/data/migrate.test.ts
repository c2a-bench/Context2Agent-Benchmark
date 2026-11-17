import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixtureSource } from "../pages/fixtures";
import { bytes, sha256, type Source } from "./inventory";
import { migrate } from "./migrate";
import { pinRelease } from "./pin-release";
import { verifyMigration } from "./verify-migration";
import { parseRelease } from "./release";
import { createDatasetLoader } from "../../src/lib/dataset-v2";

async function sourceMap() {
  const source = fixtureSource(), files = new Map<string, string>();
  for (const object of await source.list()) files.set(object.path, (await bytes(await source.read(object))).toString());
  return files;
}
function sourceFrom(files: Map<string, string>, mutate?: (files: Map<string, string>) => void): Source {
  let lists = 0;
  return { async list() { if (++lists > 1) mutate?.(files); return [...files].map(([path, value]) => ({ path, size: Buffer.byteLength(value), version: sha256(value) })); }, async read(object) { if (!files.has(object.path)) throw new Error("Missing source"); const value = files.get(object.path)!; return (async function* () { yield Buffer.from(value); })(); } };
}
const options = (source: Source, out: string) => ({ source, out, id: "fixture", benchmarkRepository: "example/benchmark", runsRepository: "example/runs", expectedRuns: 1 });

test("two-repository conversion excludes archives, reconstructs docs, preserves grading and pins provenance", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "c2a-migration-"));
  try {
    const files = await sourceMap(); files.set("archive/old/secret.json", '{"not":"selected"}');
    const traces = JSON.parse(files.get("redwood-inference/fixture/passed.json")!);
    Object.assign(traces[0], { turnsExact: false, replayVerdict: "legacy-check-disagreed", start: { runtimeFlag: true }, end: { runtimeFlag: false } });
    files.set("redwood-inference/fixture/passed.json", JSON.stringify([traces[0]])); // Stage 1 was graded, but its trace is absent.
    const report = await migrate(options(sourceFrom(files), out));
    assert.equal(report.runs, 1); assert.equal(report.stages, 2); assert.equal(report.results, 2); assert.equal(report.builderLogRuns, 0);
    assert.equal((await verifyMigration(out)).results, 2);
    await assert.rejects(migrate({ ...options(sourceFrom(files), out), license: "mit" }), /Pinned source\/configuration changed/);
    const changes = JSON.parse(await readFile(path.join(out, "benchmark/redwood-inference/stages/1/changes.json"), "utf8"));
    assert.deepEqual(changes.deleted, ["obsolete.md"]);
    const run = JSON.parse(await readFile(path.join(out, "runs/redwood-inference/fixture/run.json"), "utf8"));
    assert.equal(run.benchmark.revision, null);
    await assert.rejects(readFile(path.join(out, "runs/archive/old/run.json")), /ENOENT/);
    const pendingRelease = JSON.parse(await readFile(path.join(out, "release.json"), "utf8"));
    assert.throws(() => parseRelease(pendingRelease));
    const release = await pinRelease(out, "a".repeat(40), "b".repeat(40));
    assert.equal(parseRelease(release).benchmark.revision, "a".repeat(40));
    assert.equal((await verifyMigration(out)).runs, 1);
    const loader = createDatasetLoader({ release, read: async <T>(side: "benchmark" | "runs", file: string) => JSON.parse(await readFile(path.join(out, side, file), "utf8")) as T, text: (_side, file) => readFile(path.join(out, "runs", file), "utf8") });
    assert.equal((await loader.docs("redwood-inference"))["1"]["obsolete.md"], undefined);
    assert.equal((await loader.cases("redwood-inference", "fixture")).tickets[0].versions.length, 2);
    const restored = await loader.interactions("redwood-inference", "fixture");
    assert.equal(restored.length, 1); assert.equal(restored[0].turnsExact, false); assert.equal(restored[0].replayVerdict, "legacy-check-disagreed");
    assert.deepEqual(restored[0].start, { runtimeFlag: true }); assert.deepEqual(restored[0].end, { runtimeFlag: false });
    const missing = (await loader.results("redwood-inference", "fixture", 1))[0];
    assert.equal(missing.trace_available, false); assert.equal(missing.grading.passed, true);
    await writeFile(path.join(out, "runs/redwood-inference/fixture/stages/0/results.json"), "[]");
    await assert.rejects(verifyMigration(out), /checksum mismatch/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("Knowledge packs are replacement snapshots and builder events are redacted with resolvable content refs", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "c2a-packs-"));
  try {
    const original = await sourceMap(), files = new Map<string, string>();
    for (const [p, value] of original) files.set(p.replace(/^redwood-inference\//, "support-agent-knowledge/"), value);
    const catalog = JSON.parse(files.get("index.json")!); catalog.tasks[0].id = "support-agent-knowledge"; catalog.tasks[0].jobs[0].key = "support-agent-knowledge.fixture"; files.set("index.json", JSON.stringify(catalog));
    const prefix = "support-agent-knowledge/fixture";
    const meta = JSON.parse(files.get(`${prefix}/meta.json`)!); meta.scores["0"].step = "Rcomplete"; meta.scores["1"].step = "Rfragmented"; files.set(`${prefix}/meta.json`, JSON.stringify(meta));
    const cases = JSON.parse(files.get(`${prefix}/cases.json`)!); cases.tickets[0].versions.forEach((v: { step: string }, i: number) => { v.step = i ? "Rfragmented" : "Rcomplete"; }); files.set(`${prefix}/cases.json`, JSON.stringify(cases));
    const summary = { error: null, model: "fixture", thinking: null, cost: null, tokens: null, calls: null, commands: 0, tools: {}, failed: 0, last: null, events: 1 };
    files.set(`${prefix}/builds.json`, JSON.stringify({ version: 1, harness: "fixture", stages: [{ index: 0, step: "Rcomplete", format: "pi", summary }] }));
    const secret = "hf_" + "x".repeat(30), ref = createHash("sha1").update(secret).digest("hex").slice(0, 20);
    files.set(`${prefix}/builds/0.json`, JSON.stringify([{ k: "say", x: secret, r: ref }]));
    files.set(`${prefix}/logtexts/${ref.slice(0, 2)}.json`, JSON.stringify({ [ref]: secret }));
    await migrate(options(sourceFrom(files), out));
    const task = JSON.parse(await readFile(path.join(out, "benchmark/support-agent-knowledge/task.json"), "utf8"));
    assert.equal(task.stages[1].docs_mode, "snapshot"); assert.equal(task.stages[1].label, "Rfragmented");
    const builder = JSON.parse(await readFile(path.join(out, "runs", prefix, "stages/0/builder.json"), "utf8"));
    assert.equal(builder.events[0].x, "[secret removed]");
    assert.equal(builder.events[0].r.length, 64);
    const release = JSON.parse(await readFile(path.join(out, "release.json"), "utf8"));
    const loader = createDatasetLoader({ release, allowPending: true, read: async <T>(side: "benchmark" | "runs", file: string) => JSON.parse(await readFile(path.join(out, side, file), "utf8")) as T, text: (_side, file) => readFile(path.join(out, "runs", file), "utf8") });
    assert.deepEqual((await loader.builds("support-agent-knowledge", "fixture"))?.stages.map((s) => s.index), [0]);
    assert.equal((await verifyMigration(out)).builderStages, 1);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("uploader cache directories stay local, but arbitrary cache files are not silently accepted", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "c2a-cache-"));
  try {
    await migrate(options(sourceFrom(await sourceMap()), out));
    const cache = path.join(out, "runs/.cache");
    await mkdir(path.join(cache, "huggingface"), { recursive: true });
    await writeFile(path.join(cache, "huggingface/upload-metadata"), "local-only resumable state");
    assert.equal((await verifyMigration(out)).runs, 1);
    await rm(cache, { recursive: true }); await writeFile(cache, "not a cache directory");
    await assert.rejects(verifyMigration(out), /cache must be a local-only directory/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("credential-like strings in non-builder artifacts block completion rather than silently altering benchmark data", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "c2a-credentials-"));
  try {
    const files = await sourceMap(), meta = JSON.parse(files.get("redwood-inference/fixture/meta.json")!);
    meta.unexpectedSecret = "hf_" + "x".repeat(30); files.set("redwood-inference/fixture/meta.json", JSON.stringify(meta));
    await assert.rejects(migrate(options(sourceFrom(files), out)), /Credential-like content/);
    await assert.rejects(readFile(path.join(out, "conversion-report.json")), /ENOENT/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("active source changes block completion while unselected archive changes do not", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "c2a-freeze-"));
  try {
    const active = await sourceMap();
    await assert.rejects(migrate(options(sourceFrom(active, (f) => f.set("redwood-inference/fixture/meta.json", f.get("redwood-inference/fixture/meta.json")! + " ")), path.join(parent, "active"))), /changed during migration/);
    await assert.rejects(readFile(path.join(parent, "active/conversion-report.json")), /ENOENT/);
    const archive = await sourceMap();
    const report = await migrate(options(sourceFrom(archive, (f) => f.set("unlisted/old/code.json", "{}")), path.join(parent, "archive")));
    assert.equal(report.runs, 1);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
