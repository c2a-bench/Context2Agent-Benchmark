import { createHash } from "node:crypto";
import type { DatasetRef, DatasetRelease } from "../../src/lib/dataset-v2";
import type { FileInventory } from "./migration-io";
import { pool, safePath, sha256, retry } from "./inventory";
import { releaseUrl } from "./release";

export async function verifyRemoteDataset(ref: DatasetRef, side: "benchmark" | "runs", hub?: string) {
  const base = releaseUrl(ref, hub);
  const get = async (file: string) => {
    const res = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok || res.headers.get("content-type")?.includes("text/html")) { await res.body?.cancel(); throw new Error(`Anonymous ${side} download failed (${res.status}): ${file}`); }
    return res;
  };
  const raw = Buffer.from(await (await get("inventory.json")).arrayBuffer());
  if (sha256(raw) !== ref.inventorySha256) throw new Error(`${side} inventory checksum mismatch`);
  const inventory = JSON.parse(raw.toString()) as FileInventory;
  if (inventory.schemaVersion !== 2 || inventory.role !== side || !Array.isArray(inventory.files)) throw new Error("Invalid remote inventory");
  const paths = new Set<string>();
  for (const file of inventory.files) {
    safePath(file.path);
    if (paths.has(file.path) || file.path === "inventory.json" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid inventory path/checksum");
    paths.add(file.path);
  }
  await pool(inventory.files, 6, async (file) => retry(async () => {
    const res = await get(file.path); if (!res.body) throw new Error("Missing body");
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) { hash.update(chunk); size += chunk.length; }
    if (size !== file.size || hash.digest("hex") !== file.sha256) throw new Error(`${side} file checksum mismatch: ${file.path}`);
  }));
  return { side, files: inventory.files.length, bytes: inventory.files.reduce((n, f) => n + f.size, 0), revision: ref.revision, sourceCatalogSha256: inventory.sourceCatalogSha256 };
}
export async function verifyRemoteRelease(release: DatasetRelease, hub?: string) {
  const reports = [];
  for (const side of ["benchmark", "runs"] as const) reports.push(await verifyRemoteDataset(release[side], side, hub));
  if (reports[0].sourceCatalogSha256 !== reports[1].sourceCatalogSha256) throw new Error("Remote repositories describe different source snapshots");
  return { verification: "anonymous-full-sha256", sourceCatalogSha256: reports[0].sourceCatalogSha256, repositories: reports };
}
