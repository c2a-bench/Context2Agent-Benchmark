import { createHash } from "node:crypto";
import { JOB_FILES } from "../../src/lib/data-types";

export const INVENTORY_FILE = "__replay_inventory.json";
export type SourceObject = { path: string; size: number; version: string };
export type Entry = SourceObject & { sha256: string; references: string[]; keys?: string[] };
export type Inventory = { schemaVersion: 1; snapshot: string; sourcePrefix: string; sourceFingerprint: string; createdAt: string; totalBytes: number; objects: Entry[] };
export interface Source {
  list(): Promise<SourceObject[]>;
  read(object: SourceObject): Promise<AsyncIterable<Uint8Array>>;
}
export function sha256(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
export function safePath(value: string) {
  if (!value || value.split("/").some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) throw new Error(`Unsafe data path: ${value}`);
  return value;
}
export function snapshotId(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error("Invalid export ID");
  return value;
}
export function sorted(objects: SourceObject[]) {
  const seen = new Set<string>();
  for (const entry of objects) {
    safePath(entry.path);
    if (entry.path === INVENTORY_FILE || seen.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !entry.version) throw new Error(`Invalid/reserved source object: ${entry.path}`);
    seen.add(entry.path);
  }
  if (!seen.has("index.json")) throw new Error("Source has no index.json");
  return [...objects].sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export function fingerprint(objects: SourceObject[]) {
  return sha256(JSON.stringify(sorted(objects).map(({ path, size, version }) => ({ path, size, version }))));
}
export async function bytes(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Concurrency must be 1–32");
  let next = 0;
  let failed = false;
  let error: unknown;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try { await work(items[i]); } catch (cause) { failed = true; error = cause; }
    }
  }));
  if (failed) throw error;
}
export async function retry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await work(); } catch (error) {
      if (i >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (i - 1)));
    }
  }
}

export function inspectJson(file: string, value: unknown): Pick<Entry, "references" | "keys"> {
  const refs = new Set<string>();
  const root = file.split("/").slice(0, 2).join("/");
  const walk = (v: unknown, log: boolean) => {
    if (!v || typeof v !== "object") return;
    for (const [key, child] of Object.entries(v)) {
      if ((log ? ["r", "ri"] : ["ref", "old_ref", "new_ref"]).includes(key) && typeof child === "string" && child) {
        if (!/^[a-f0-9]{2,64}$/.test(child)) throw new Error(`Invalid text reference in ${file}`);
        refs.add(`${root}/${log ? "logtexts" : "texts"}/${child.slice(0, 2)}.json#${child}`);
      } else if (typeof child === "object") walk(child, log);
    }
  };
  if (/^[^/]+\/[^/]+\/(code|docs)\.json$/.test(file)) walk(value, false);
  if (/^[^/]+\/[^/]+\/builds\/\d+\.json$/.test(file)) walk(value, true);
  if (/^[^/]+\/[^/]+\/builds\.json$/.test(file)) {
    const data = value as { stages: { index: number }[] };
    if (!Array.isArray(data.stages)) throw new Error(`Invalid stages in ${file}`);
    for (const stage of data.stages) {
      if (!Number.isInteger(stage.index) || stage.index < 0 || stage.index > 999) throw new Error(`Invalid build index in ${file}`);
      refs.add(`${root}/builds/${stage.index}.json`);
    }
  }
  if (file === "index.json") {
    const catalog = value as { tasks: { id: string; jobs: { id: string }[] }[] };
    if (!Array.isArray(catalog.tasks) || !catalog.tasks.length) throw new Error("Catalog has no tasks");
    const runs = new Set<string>();
    for (const task of catalog.tasks) {
      if (typeof task.id !== "string" || !Array.isArray(task.jobs)) throw new Error("Invalid catalog task");
      for (const job of task.jobs) {
        if (typeof job.id !== "string" || task.id.includes("/") || job.id.includes("/")) throw new Error("Invalid run ID");
        const run = safePath(`${task.id}/${job.id}`);
        if (runs.has(run)) throw new Error(`Duplicate run ${run}`);
        runs.add(run);
        for (const file of JOB_FILES) refs.add(`${run}/${file}`);
      }
    }
    if (!runs.size) throw new Error("Catalog has no runs");
  }
  const shard = /\/(texts|logtexts)\/[a-f0-9]{2}\.json$/.test(file);
  if (shard && (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => typeof v !== "string"))) throw new Error(`Invalid text shard ${file}`);
  return { references: [...refs].sort(), ...(shard ? { keys: Object.keys(value as object).sort() } : {}) };
}
export function validateReferences(entries: Entry[]) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) for (const ref of entry.references) {
    const [file, key] = ref.split("#");
    if (!byPath.has(file) || (key && !byPath.get(file)!.keys?.includes(key))) throw new Error(`Missing reference ${ref} from ${entry.path}`);
  }
}
export function parseInventory(value: unknown): Inventory {
  const inventory = value as Inventory;
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.objects)) throw new Error("Invalid replay inventory");
  sorted(inventory.objects);
  for (const entry of inventory.objects) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Array.isArray(entry.references) || entry.references.some((r) => typeof r !== "string")) throw new Error(`Invalid inventory entry ${entry.path}`);
  }
  if (inventory.totalBytes !== inventory.objects.reduce((n, entry) => n + entry.size, 0) || inventory.sourceFingerprint !== fingerprint(inventory.objects)) throw new Error("Inventory totals/source fingerprint mismatch");
  validateReferences(inventory.objects);
  return inventory;
}
