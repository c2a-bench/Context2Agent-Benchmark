import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { blobSource } from "./blob";
import { exportSnapshot, verifyLocal } from "./export";
import { inspectJson, safePath, sha256, type Source, type SourceObject } from "./inventory";
import { verifyRemoteRelease } from "./verify-remote-release";
import { fixtures } from "../pages/fixtures";

class MemorySource implements Source {
  files = new Map<string, string>([["index.json", JSON.stringify({ tasks: [{ id: "t", jobs: [{ id: "j" }] }] })], ...["meta", "tickets", "code", "docs"].map((name): [string, string] => [`t/j/${name}.json`, "{}"])]);
  reads: string[] = [];
  fail = new Set<string>();
  lists = 0;
  changeOnFinalList = false;
  async list() {
    if (++this.lists > 1 && this.changeOnFinalList) this.files.set("index.json", this.files.get("index.json")! + " ");
    return [...this.files].map(([path, body]) => ({ path, size: Buffer.byteLength(body), version: sha256(body) }));
  }
  async read(object: SourceObject) {
    this.reads.push(object.path);
    if (this.fail.has(object.path)) throw new Error("simulated interruption");
    const body = this.files.get(object.path)!;
    return (async function* () { yield Buffer.from(body); })();
  }
}
const exportTo = (source: MemorySource, dir: string, snapshot = "v1", reuse?: string) => exportSnapshot({ source, dir, snapshot, sourcePrefix: "observe-bench", concurrency: 1, reuse });

test("local export validates references, resumes, rejects source changes, and detects corruption", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-export-test-"));
  try {
    const source = new MemorySource();
    source.fail.add("t/j/tickets.json");
    await assert.rejects(exportTo(source, dir), /simulated interruption/);
    await assert.rejects(readFile(path.join(dir, "complete.json")), /ENOENT/);
    await assert.rejects(readFile(path.join(dir, "upload/replays/v1/index.json")), /ENOENT/);
    source.fail.clear(); source.reads = [];
    const completed = await exportTo(source, dir);
    assert.equal(completed.path, "replays/v1");
    assert.deepEqual(source.reads.sort(), ["index.json", "t/j/tickets.json"]);
    assert.equal((await verifyLocal(dir)).inventory.objects.length, 5);
    assert.deepEqual(await exportTo(source, dir), completed);
    source.files.set("t/j/meta.json", '{"new":true}');
    await assert.rejects(exportTo(source, dir), /source changed/);
    await writeFile(path.join(dir, "upload/replays/v1/t/j/meta.json"), "[]");
    await assert.rejects(verifyLocal(dir), /checksum mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reuse verified local files without Blob downloads; unexpected files cannot be published", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-reuse-test-"));
  try {
    const source = new MemorySource();
    const first = path.join(dir, "first"), second = path.join(dir, "second");
    await exportTo(source, first);
    source.files.set("t/j/meta.json", '{"new":true}'); source.reads = [];
    await exportTo(source, second, "v2", first);
    assert.deepEqual(source.reads, ["t/j/meta.json"]);
    await writeFile(path.join(second, "upload/replays/v2/unreviewed.json"), "{}");
    await assert.rejects(verifyLocal(second), /unexpected files/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("changed source or missing shard reference never completes an export", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-consistency-test-"));
  try {
    const source = new MemorySource(); source.changeOnFinalList = true;
    await assert.rejects(exportTo(source, path.join(dir, "changed")), /Blob changed during export/);
    const missing = new MemorySource(); missing.files.set("t/j/docs.json", JSON.stringify({ ref: "ab1234" }));
    await assert.rejects(exportTo(missing, path.join(dir, "missing")), /Missing reference/);
    await assert.rejects(readFile(path.join(dir, "missing/complete.json")), /ENOENT/);
    for (const invalid of ["../x", "/x", "a//b", "a?x"]) assert.throws(() => safePath(invalid));
    assert.deepEqual(inspectJson("t/j/builds/2.json", [{ r: "aa1234", ri: "bb1234" }]).references, ["t/j/logtexts/aa.json#aa1234", "t/j/logtexts/bb.json#bb1234"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("public HF verification follows redirects, accepts text/plain JSON, and checks SHA-256", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-readback-test-"));
  const server = await fixtures(dir, "/");
  try {
    const report = await verifyRemoteRelease(server.selection, server.dataOrigin);
    assert.equal(report.verification, "anonymous-full-sha256");
    assert.equal(report.repositories.length, 2);
    server.corrupt("runs/redwood-inference/fixture/stages/0/stage.json", "{}");
    await assert.rejects(verifyRemoteRelease(server.selection, server.dataOrigin), /checksum mismatch/);
    await assert.rejects(verifyRemoteRelease({ ...server.selection, benchmark: { ...server.selection.benchmark, inventorySha256: "0".repeat(64) } }, server.dataOrigin), /inventory checksum mismatch/);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Blob adapter paginates, normalizes ETags, and rejects stale CDN responses", async () => {
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "test-only-no-network";
  try {
    let stale = false;
    const api = {
      async list(options: { cursor?: string }) {
        const file = options.cursor ? "t/j/meta.json" : "index.json";
        return { blobs: [{ pathname: `p/${file}`, size: 1, etag: "etag", uploadedAt: new Date("2026-01-01T00:00:00.123Z"), downloadUrl: `https://test.public.blob.vercel-storage.com/p/${file}` }], hasMore: !options.cursor, cursor: options.cursor ? undefined : "page2" };
      },
      async get(url: string) {
        assert.ok(new URL(url).searchParams.get("snapshot-export"));
        return { statusCode: 200, stream: new ReadableStream({ start(c) { c.enqueue(Buffer.from("x")); c.close(); } }), blob: { etag: stale ? '"old"' : '"etag"', size: 1, uploadedAt: new Date("2026-01-01T00:00:00Z") } };
      },
    } as unknown as NonNullable<Parameters<typeof blobSource>[1]>;
    const source = blobSource("p", api);
    const objects = await source.list();
    assert.equal(objects.length, 2);
    for await (const chunk of await source.read(objects[0])) assert.equal(Buffer.from(chunk).toString(), "x");
    stale = true;
    await assert.rejects(source.read(objects[0]), /CDN is stale/);
  } finally {
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
});
