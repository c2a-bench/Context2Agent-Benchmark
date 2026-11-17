import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeLeaderboardRow, type DatasetRelease, type RunRecord, type StageRecord } from "../../src/lib/dataset-v2";
import { inventoryDirectory, verifyDirectory, writeJson } from "./migration-io";

export async function pinRelease(out: string, benchmarkRevision: string, runsRevision?: string) {
  if (!/^[a-f0-9]{40}$/.test(benchmarkRevision) || (runsRevision && !/^[a-f0-9]{40}$/.test(runsRevision))) throw new Error("Use full immutable commit SHAs");
  const release = JSON.parse(await readFile(path.join(out, "release.json"), "utf8")) as DatasetRelease;
  const benchmark = await verifyDirectory(path.join(out, "benchmark"), release.benchmark.inventorySha256);
  const oldRuns = await verifyDirectory(path.join(out, "runs"), release.runs.inventorySha256);
  if (benchmark.sourceCatalogSha256 !== oldRuns.sourceCatalogSha256) throw new Error("Mismatched source snapshots");
  for (const domain of release.domains) {
    const rows = (await readFile(path.join(out, "runs/data", `${domain}.jsonl`), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const updated = [];
    for (const row of rows) {
      const file = path.join(out, "runs", domain, row.id, "run.json");
      const run = JSON.parse(await readFile(file, "utf8")) as RunRecord;
      if (run.benchmark.repository !== release.benchmark.repository || run.benchmark.inventorySha256 !== release.benchmark.inventorySha256) throw new Error("Benchmark identity mismatch");
      run.benchmark.revision = benchmarkRevision;
      await writeJson(file, run);
      const stages = await Promise.all(run.stages.map(async (n) => JSON.parse(await readFile(path.join(out, "runs", domain, row.id, "stages", String(n), "stage.json"), "utf8")) as StageRecord));
      updated.push(makeLeaderboardRow(run, stages));
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(out, "runs/data", `${domain}.jsonl`), updated.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  release.benchmark.revision = benchmarkRevision;
  release.runs.inventorySha256 = (await inventoryDirectory(path.join(out, "runs"), "runs", oldRuns.sourceCatalogSha256)).sha256;
  release.runs.revision = runsRevision ?? null as unknown as string;
  await writeJson(path.join(out, "release.json"), release);
  return release;
}
