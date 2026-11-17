import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safePath, sha256, retry, type Source, type SourceObject } from "./inventory";

export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const digest = (value: unknown) => sha256(canonical(value));
export async function exists(file: string) {
  try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function fileSha(file: string) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export async function diskGuard(dir: string, additional = 0) {
  const fs = await statfs(dir);
  if (fs.bavail * fs.bsize - additional < 512 * 1024 ** 2) throw new Error("Less than 512 MiB free disk space would remain; conversion stopped safely. Free space and resume.");
}
export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify(value) + "\n";
  await diskGuard(path.dirname(file), Buffer.byteLength(body));
  await writeFile(`${file}.part`, body); await rename(`${file}.part`, file);
}
export async function allFiles(root: string, prefix = ""): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in releases");
    if (!prefix && entry.name === ".cache") {
      if (!entry.isDirectory()) throw new Error("Release .cache must be a local-only directory");
      continue; // HF uploader's local-only resumable cache; never uploaded.
    }
    const p = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await allFiles(root, p)); else if (entry.isFile()) output.push(p);
  }
  return output.sort();
}
export type FileInventory = { schemaVersion: 2; role: "benchmark" | "runs"; sourceCatalogSha256: string; files: { path: string; size: number; sha256: string }[] };
export async function inventoryDirectory(root: string, role: FileInventory["role"], sourceCatalogSha256: string) {
  const files = [];
  for (const name of await allFiles(root)) {
    if (name === "inventory.json") continue;
    if (name.endsWith(".part")) throw new Error(`Incomplete release file ${name}`);
    const file = path.join(root, name); files.push({ path: name, size: (await stat(file)).size, sha256: await fileSha(file) });
  }
  const inventory: FileInventory = { schemaVersion: 2, role, sourceCatalogSha256, files };
  await writeJson(path.join(root, "inventory.json"), inventory);
  return { inventory, sha256: await fileSha(path.join(root, "inventory.json")) };
}
export async function verifyDirectory(root: string, expectedSha?: string) {
  const raw = await readFile(path.join(root, "inventory.json"));
  if (expectedSha && sha256(raw) !== expectedSha) throw new Error(`Inventory checksum mismatch: ${root}`);
  const inventory = JSON.parse(raw.toString()) as FileInventory;
  if (inventory.schemaVersion !== 2 || !Array.isArray(inventory.files)) throw new Error("Invalid release inventory");
  const expected = [...inventory.files.map((f) => safePath(f.path)), "inventory.json"].sort();
  if (new Set(expected).size !== expected.length || canonical(await allFiles(root)) !== canonical(expected)) throw new Error(`Unexpected/missing output files: ${root}`);
  for (const entry of inventory.files) {
    const file = path.join(root, entry.path);
    if ((await stat(file)).size !== entry.size || await fileSha(file) !== entry.sha256) throw new Error(`File checksum mismatch: ${entry.path}`);
    if (/\.(json|jsonl|md)$/.test(file) && credentialLike(await readFile(file, "utf8"))) throw new Error(`Credential-like content in ${entry.path}; review before publication`);
  }
  return inventory;
}
export class MigrationReader {
  objects: Map<string, SourceObject>;
  private docs = new Map<string, Promise<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private source: Source, objects: SourceObject[], private dir: string, private seed?: { root: string; mappings: Record<string, string>; objects: Map<string, SourceObject> }, private log: (message: string) => void = () => {}) { this.objects = new Map(objects.map((o) => [o.path, o])); }
  has(name: string) { return this.objects.has(name); }
  async json<T>(name: string): Promise<T> {
    const object = this.objects.get(safePath(name)); if (!object) throw new Error(`Missing source object ${name}`);
    if (name.endsWith("/docs.json")) {
      const signature = `${object.version.split("|")[0]}:${object.size}`;
      if (!this.docs.has(signature)) this.docs.set(signature, this.download(object));
      return this.docs.get(signature) as Promise<T>;
    }
    if (!this.inflight.has(name)) {
      const promise = this.download(object); this.inflight.set(name, promise);
      promise.finally(() => this.inflight.delete(name)).catch(() => {});
    }
    return this.inflight.get(name) as Promise<T>;
  }
  private async download(object: SourceObject): Promise<unknown> {
    const file = path.join(this.dir, "source", object.path), receipt = `${file}.receipt`;
    await mkdir(path.dirname(file), { recursive: true });
    if (await exists(file) && await exists(receipt)) {
      const saved = JSON.parse(await readFile(receipt, "utf8"));
      if (saved.version === object.version && saved.size === object.size && await fileSha(file) === saved.sha256) return JSON.parse(await readFile(file, "utf8"));
    }
    const seedObject = this.seed?.objects.get(object.path), seedFile = this.seed?.mappings[object.path];
    if (seedObject?.version === object.version && seedObject.size === object.size && seedFile) {
      const from = path.join(this.seed!.root, safePath(seedFile));
      if (await exists(from) && (await stat(from)).size === object.size) {
        // Optional trusted audit input: its bytes were checked against these exact versions when fetched.
        // Normal operation uses the checksummed source cache below; this seed is never used by CI.
        const data = JSON.parse(await readFile(from, "utf8"));
        this.log(`audit-cache ${object.path}`); return data;
      }
    }
    await diskGuard(this.dir, object.size);
    return retry(async () => {
      let size = 0; const hash = createHash("sha256");
      try {
        await pipeline(await this.source.read(object), new Transform({ transform(chunk, _enc, done) { size += chunk.length; hash.update(chunk); done(null, chunk); } }), createWriteStream(`${file}.part`));
        if (size !== object.size) throw new Error(`Source byte-count mismatch ${object.path}`);
        const value = JSON.parse(await readFile(`${file}.part`, "utf8"));
        await rename(`${file}.part`, file);
        await writeJson(receipt, { version: object.version, size, sha256: hash.digest("hex") });
        this.log(`download ${object.path}`); return value;
      } finally { await rm(`${file}.part`, { force: true }); }
    });
  }
  async pruneJob(prefix: string) { await rm(path.join(this.dir, "source", safePath(prefix)), { recursive: true, force: true }); }
}

export function credentialLike(text: string) {
  return /\b(?:hf_[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|vercel_blob_rw_[A-Za-z0-9_]{20,}|sk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,})\b/.test(text);
}
export function redact(text: string) {
  return text.replace(/\b(?:hf_[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|vercel_blob_rw_[A-Za-z0-9_]{20,}|sk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,})\b/g, "[secret removed]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [secret removed]");
}
export class ContentStore {
  private buckets = new Map<string, Record<string, string>>();
  private sourceRefs = new Map<string, string>();
  private dirty = new Set<string>();
  private used = new Set<string>();
  private shards = new Map<string, Promise<Record<string, string>>>();
  constructor(private root: string, private source: MigrationReader) {}
  async restore() {
    const dir = path.join(this.root, "content/texts"); if (!await exists(dir)) return;
    for (const file of await readdir(dir)) {
      if (/^[a-f0-9]{2}\.json\.part$/.test(file)) { await rm(path.join(dir, file)); continue; }
      if (!/^[a-f0-9]{2}\.json$/.test(file)) throw new Error("Unexpected content-store file");
      const values = JSON.parse(await readFile(path.join(dir, file), "utf8"));
      for (const [ref, text] of Object.entries(values)) {
        if (typeof text !== "string" || sha256(text) !== ref) throw new Error("Content-store checksum mismatch");
        this.remember(ref, text);
      }
      this.buckets.set(file.slice(0, 2), values);
    }
  }
  private remember(hash: string, text: string) {
    this.sourceRefs.set(`texts:${hash.slice(0, 20)}`, hash);
    this.sourceRefs.set(`logtexts:${createHash("sha1").update(text).digest("hex").slice(0, 20)}`, hash);
  }
  put(text: string, used = true) {
    const hash = sha256(text), bucket = hash.slice(0, 2);
    if (used) this.used.add(hash);
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, {});
    if (!(hash in this.buckets.get(bucket)!)) { this.buckets.get(bucket)![hash] = text; this.dirty.add(bucket); }
    this.remember(hash, text); return hash;
  }
  get(hash: string) {
    const text = this.buckets.get(hash.slice(0, 2))?.[hash]; if (typeof text !== "string") throw new Error(`Missing converted text ${hash}`); return text;
  }
  async resolve(prefix: string, kind: "texts" | "logtexts", ref: string) {
    if (!/^[a-f0-9]{20}$/.test(ref)) throw new Error(`Invalid source reference ${ref}`);
    const known = this.sourceRefs.get(`${kind}:${ref}`); if (known) return this.get(known);
    const file = `${prefix}/${kind}/${ref.slice(0, 2)}.json`;
    if (!this.shards.has(file)) {
      if (this.shards.size > 12) this.shards.delete(this.shards.keys().next().value!);
      this.shards.set(file, this.source.json(file));
    }
    const shard = await this.shards.get(file)!;
    const value = shard[ref]; if (typeof value !== "string") throw new Error(`Missing source text ${file}#${ref}`);
    const algorithm = kind === "texts" ? "sha256" : "sha1";
    // Ingest the whole shard once. Keeping only one requested entry would re-download the same
    // corpus thousands of times as the UI's hash-distributed references are encountered.
    for (const [sourceRef, text] of Object.entries(shard)) {
      if (typeof text !== "string" || createHash(algorithm).update(text).digest("hex").slice(0, 20) !== sourceRef) throw new Error("Source text checksum mismatch");
      const hash = this.put(kind === "logtexts" ? redact(text) : text, false);
      this.sourceRefs.set(`${kind}:${sourceRef}`, hash);
    }
    return this.get(this.sourceRefs.get(`${kind}:${ref}`)!);
  }
  async reference(prefix: string, kind: "texts" | "logtexts", ref: string) {
    const text = await this.resolve(prefix, kind, ref);
    const hash = this.put(kind === "logtexts" ? redact(text) : text);
    this.sourceRefs.set(`${kind}:${ref}`, hash); return hash;
  }
  async pruneUnused() {
    for (const [bucket, entries] of this.buckets) {
      for (const hash of Object.keys(entries)) if (!this.used.has(hash)) { delete entries[hash]; this.dirty.add(bucket); }
      if (!Object.keys(entries).length) { this.buckets.delete(bucket); this.dirty.delete(bucket); await rm(path.join(this.root, `content/texts/${bucket}.json`), { force: true }); }
    }
  }
  async flush() {
    for (const bucket of this.dirty) await writeJson(path.join(this.root, `content/texts/${bucket}.json`), this.buckets.get(bucket));
    this.dirty.clear();
  }
}
