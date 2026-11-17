import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fingerprint, inspectJson, INVENTORY_FILE, parseInventory, pool, retry, sha256, snapshotId, sorted, validateReferences, type Entry, type Inventory, type Source } from "./inventory";

export type Complete = { schemaVersion: 1; snapshot: string; path: string; inventorySha256: string };
async function exists(file: string) {
  try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function paths(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in exported replay data");
    if (entry.isDirectory()) found.push(...(await paths(path.join(dir, entry.name))).map((name) => `${entry.name}/${name}`));
    else if (entry.isFile()) found.push(entry.name);
    else throw new Error("Unexpected filesystem entry");
  }
  return found.sort();
}
export async function verifyLocal(dir: string) {
  const complete = JSON.parse(await readFile(path.join(dir, "complete.json"), "utf8")) as Complete;
  const id = snapshotId(complete.snapshot);
  if (complete.schemaVersion !== 1 || complete.path !== `replays/${id}`) throw new Error("Invalid completed export");
  const root = path.join(dir, "upload", complete.path);
  const raw = await readFile(path.join(root, INVENTORY_FILE));
  if (sha256(raw) !== complete.inventorySha256) throw new Error("Local inventory checksum mismatch");
  const inventory = parseInventory(JSON.parse(raw.toString("utf8")));
  if (inventory.snapshot !== id) throw new Error("Export ID mismatch");
  const expected = [...inventory.objects.map((entry) => entry.path), INVENTORY_FILE].sort();
  if (JSON.stringify(await paths(root)) !== JSON.stringify(expected)) throw new Error("Local export contains missing/unexpected files");
  await pool(inventory.objects, 4, async (entry) => {
    const file = path.join(root, entry.path);
    if ((await stat(file)).size !== entry.size || await fileHash(file) !== entry.sha256) throw new Error(`Local checksum mismatch: ${entry.path}`);
  });
  return { complete, inventory, root };
}
export async function exportSnapshot(options: { source: Source; dir: string; snapshot: string; sourcePrefix: string; concurrency?: number; reuse?: string; log?: (message: string) => void }) {
  const { source, dir, sourcePrefix } = options;
  const snapshot = snapshotId(options.snapshot);
  const concurrency = options.concurrency ?? 4;
  const log = options.log ?? (() => {});
  const objects = sorted(await source.list());
  const sourceFingerprint = fingerprint(objects);
  await mkdir(dir, { recursive: true });
  if (await exists(path.join(dir, "complete.json"))) {
    const previous = await verifyLocal(dir);
    if (previous.inventory.sourceFingerprint !== sourceFingerprint || previous.inventory.sourcePrefix !== sourcePrefix || previous.complete.snapshot !== snapshot) throw new Error("Completed export source changed; use a new export ID/directory");
    return previous.complete;
  }
  const stateFile = path.join(dir, "source.json");
  if (await exists(stateFile)) {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.sourceFingerprint !== sourceFingerprint || state.sourcePrefix !== sourcePrefix || state.snapshot !== snapshot) throw new Error("Partial export source changed; use a new export ID/directory");
  } else await writeFile(stateFile, JSON.stringify({ snapshot, sourcePrefix, sourceFingerprint, objects }), { flag: "wx" });
  const root = path.join(dir, "upload", "replays", snapshot);
  await mkdir(root, { recursive: true });
  const previous = options.reuse ? await verifyLocal(options.reuse) : null;
  const oldEntries = new Map(previous?.inventory.objects.map((entry) => [entry.path, entry]));
  const entries = new Map<string, Entry>();
  const catalogFile = path.join(dir, "catalog.part");
  await pool(objects, concurrency, async (object) => {
    const file = object.path === "index.json" ? catalogFile : path.join(root, object.path);
    const progress = path.join(dir, "progress", `${object.path}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(progress), { recursive: true });
    if (object.path !== "index.json" && await exists(file) && await exists(progress)) {
      const saved = JSON.parse(await readFile(progress, "utf8")) as Entry;
      if (saved.path === object.path && saved.version === object.version && saved.size === object.size && (await stat(file)).size === object.size && await fileHash(file) === saved.sha256) {
        entries.set(object.path, saved); log(`resume ${object.path}`); return;
      }
    }
    const old = oldEntries.get(object.path);
    if (previous && old && old.version === object.version && old.size === object.size) {
      await copyFile(path.join(previous.root, object.path), file);
      entries.set(object.path, old);
      if (object.path !== "index.json") await writeFile(progress, JSON.stringify(old));
      log(`reuse ${object.path}`); return;
    }
    const temporary = `${file}.part`;
    try {
      const entry = await retry(async () => {
        const hash = createHash("sha256");
        let size = 0;
        await pipeline(await source.read(object), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } }), createWriteStream(temporary));
        if (size !== object.size) throw new Error(`Blob byte count changed: ${object.path}`);
        const inspected = object.path.endsWith(".json") ? inspectJson(object.path, JSON.parse(await readFile(temporary, "utf8"))) : { references: [] };
        return { ...object, sha256: hash.digest("hex"), ...inspected } as Entry;
      });
      await rename(temporary, file);
      entries.set(object.path, entry);
      if (object.path !== "index.json") await writeFile(progress, JSON.stringify(entry));
      log(`download ${object.path}`);
    } finally { await rm(temporary, { force: true }); }
  });
  const all = objects.map((object) => entries.get(object.path)!);
  validateReferences(all);
  if (fingerprint(await source.list()) !== sourceFingerprint) throw new Error("Blob changed during export. Pause publishing and use a new export ID.");
  await rename(catalogFile, path.join(root, "index.json"));
  const expected = all.map((entry) => entry.path).sort();
  if (JSON.stringify((await paths(root)).filter((name) => name !== INVENTORY_FILE)) !== JSON.stringify(expected)) throw new Error("Unexpected files in export; do not upload this folder");
  const inventory: Inventory = { schemaVersion: 1, snapshot, sourcePrefix, sourceFingerprint, createdAt: new Date().toISOString(), totalBytes: all.reduce((n, entry) => n + entry.size, 0), objects: all };
  const raw = JSON.stringify(inventory, null, 2) + "\n";
  await writeFile(path.join(root, INVENTORY_FILE), raw);
  const complete: Complete = { schemaVersion: 1, snapshot, path: `replays/${snapshot}`, inventorySha256: sha256(raw) };
  await writeFile(path.join(dir, "complete.json"), JSON.stringify(complete, null, 2) + "\n", { flag: "wx" });
  await verifyLocal(dir);
  return complete;
}
