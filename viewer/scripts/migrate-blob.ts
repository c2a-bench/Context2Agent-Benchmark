import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { blobSource } from "./data/blob";
import { migrate } from "./data/migrate";
import { repositoryId } from "./data/huggingface";
import type { SourceObject } from "./data/inventory";

const { values } = parseArgs({ options: {
  id: { type: "string" }, out: { type: "string" }, prefix: { type: "string", default: process.env.BLOB_PREFIX || "observe-bench" },
  "benchmark-repo": { type: "string", default: process.env.HF_BENCHMARK_REPO },
  "runs-repo": { type: "string", default: process.env.HF_RUNS_REPO },
  "expected-runs": { type: "string" }, license: { type: "string" },
  "seed-audit": { type: "string" }, "seed-inventory": { type: "string" }, help: { type: "boolean" },
} });
if (values.help) console.log("Usage: npm run migrate:blob -- --id RELEASE --benchmark-repo OWNER/DATASET --runs-repo OWNER/DATASET --expected-runs COUNT [--out .migration/RELEASE] [--license bsd]\nRead-only Blob migration: selects only cataloged runs, deduplicates benchmark definitions, creates benchmark/ and runs/ locally. No HF upload or Pages deployment. Optional --seed-audit DIR --seed-inventory FILE reuse a previously version-checked audit.");
else {
  try {
    if (!values.id) throw new Error("--id is required");
    const benchmark = values["benchmark-repo"], runs = values["runs-repo"];
    if (!benchmark || !runs) throw new Error("Explicit --benchmark-repo and --runs-repo (or HF_BENCHMARK_REPO/HF_RUNS_REPO) are required; there is no default dataset");
    const benchmarkRepository = repositoryId(benchmark), runsRepository = repositoryId(runs);
    if (benchmarkRepository === runsRepository) throw new Error("Use distinct benchmark and runs repositories");
    const expectedRuns = values["expected-runs"] ? Number(values["expected-runs"]) : undefined;
    if (expectedRuns !== undefined && (!Number.isInteger(expectedRuns) || expectedRuns < 1)) throw new Error("--expected-runs must be a positive integer");
    let seed;
    if (values["seed-audit"] || values["seed-inventory"]) {
      if (!values["seed-audit"] || !values["seed-inventory"]) throw new Error("Both seed flags are required");
      const inventory = JSON.parse(await readFile(values["seed-inventory"], "utf8"));
      seed = { root: values["seed-audit"], mappings: JSON.parse(await readFile(`${values["seed-audit"]}/_files.json`, "utf8")), objects: new Map<string, SourceObject>(inventory.objects.map((o: SourceObject) => [o.path, o])) };
    }
    const report = await migrate({ source: blobSource(values.prefix), out: values.out || `.migration/${values.id}`, id: values.id, benchmarkRepository, runsRepository, expectedRuns, license: values.license, seed, log: console.log });
    const { validation: _validation, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }
}
