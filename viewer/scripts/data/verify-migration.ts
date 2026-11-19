import { TEXT_SHARD } from "../../src/lib/dataset-v2";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createDatasetLoader, type DatasetRelease, type StageCode, type BuilderRecord } from "../../src/lib/dataset-v2";
import { canonical, digest, verifyDirectory } from "./migration-io";
import { sha256 } from "./inventory";

export async function verifyMigration(out: string) {
  const release = JSON.parse(await readFile(path.join(out, "release.json"), "utf8")) as DatasetRelease;
  const [benchmark, runs] = await Promise.all([verifyDirectory(path.join(out, "benchmark"), release.benchmark.inventorySha256), verifyDirectory(path.join(out, "runs"), release.runs.inventorySha256)]);
  if (benchmark.role !== "benchmark" || runs.role !== "runs" || benchmark.sourceCatalogSha256 !== runs.sourceCatalogSha256) throw new Error("Dataset inventories do not describe one source snapshot");
  const report = JSON.parse(await readFile(path.join(out, "conversion-report.json"), "utf8"));
  if (report.sourceCatalogSha256 !== benchmark.sourceCatalogSha256) throw new Error("Conversion report provenance mismatch");
  const refs = new Set<string>();
  const shardFile = new RegExp(`^content/texts/[a-f0-9]{${TEXT_SHARD}}\\.json$`);
  const contentFiles = runs.files.filter((file) => shardFile.test(file.path));
  for (const file of contentFiles) {
    const shard = JSON.parse(await readFile(path.join(out, "runs", file.path), "utf8"));
    for (const [hash, text] of Object.entries(shard)) {
      if (typeof text !== "string" || sha256(text) !== hash || !file.path.endsWith(`/${hash.slice(0, TEXT_SHARD)}.json`)) throw new Error(`Invalid content-addressed text in ${file.path}`);
      refs.add(hash);
    }
  }
  const usedRefs = new Set<string>();
  const checkRefs = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["ref", "old_ref", "new_ref", "r", "ri"].includes(key) && typeof child === "string" && child) {
        if (!refs.has(child)) throw new Error(`Unresolved output reference ${child}`);
        usedRefs.add(child);
      } else if (typeof child === "object") checkRefs(child);
    }
  };
  const read = async <T>(side: "benchmark" | "runs", file: string) => JSON.parse(await readFile(path.join(out, side, file), "utf8")) as T;
  const text = (_side: "runs", file: string) => readFile(path.join(out, "runs", file), "utf8");
  let runCount = 0, stageCount = 0, resultCount = 0, builderCount = 0;
  const checkedDomains = new Set<string>();
  const index = await createDatasetLoader({ release, read, text, allowPending: true }).index();
  for (const task of index.tasks) for (const job of task.jobs) {
    // Per-run loaders keep validation memory bounded; a browser normally opens only one run at a time.
    const loader = createDatasetLoader({ release, read, text, allowPending: true });
    const run = await loader.run(task.id, job.id), meta = await loader.meta(task.id, job.id);
    const cases = await loader.cases(task.id, job.id), interactions = await loader.interactions(task.id, job.id), code = await loader.code(task.id, job.id);
    const expected = report.validation.find((item: { domain: string; job: string }) => item.domain === task.id && item.job === job.id);
    if (!expected) throw new Error("Unexpected run in release");
    if (!checkedDomains.has(task.id)) {
      const docs = await loader.docs(task.id);
      for (const [n, collection] of Object.entries(docs)) if (digest(collection) !== expected.docsHashes[n]) throw new Error(`Document reconstruction failed ${task.id}/${n}`);
      checkedDomains.add(task.id);
    }
    let caseCount = 0;
    for (const n of run.stages) {
      const records = await loader.results(task.id, job.id, n), score = meta.scores[String(n)];
      if (records.length !== score.total || records.filter((r) => r.passed).length !== score.passed) throw new Error(`Result/score mismatch ${task.id}/${job.id}/${n}`);
      const caseRows = cases.tickets.flatMap((c) => c.versions.filter((v) => v.step === score.step));
      if (caseRows.length !== records.length || caseRows.filter((c) => c.result?.passed).length !== score.passed) throw new Error("Reconstructed cases do not match outcomes");
      const traces = records.filter((r) => r.trace_available), reconstructed = interactions.filter((t) => t.stage === n);
      if (traces.length !== reconstructed.length || traces.filter((r) => r.passed).length !== reconstructed.filter((r) => r.passed).length) throw new Error("Interaction projection failed");
      const c = await read<StageCode>("runs", `${task.id}/${job.id}/stages/${n}/code.json`);
      if (digest(c) !== expected.codeHashes[String(n)] || canonical(code.stages.find((s) => s.stage === n)?.files) !== canonical(c.files)) throw new Error("Code snapshot projection mismatch");
      checkRefs(c);
      const stage = await loader.stage(task.id, job.id, n);
      if (stage.build_log.available) {
        const builder = await read<BuilderRecord>("runs", `${task.id}/${job.id}/stages/${n}/builder.json`);
        if (!builder.redacted || builder.format !== "normalized-events-v1") throw new Error("Builder artifact is not declared redacted normalized events");
        checkRefs(builder.events); builderCount++;
      }
      caseCount += records.length; stageCount++; resultCount += records.length;
    }
    if (caseCount !== expected.results || run.stages.length !== expected.stages) throw new Error("Per-run totals changed");
    runCount++;
  }
  if (usedRefs.size !== refs.size) throw new Error("Unreferenced texts remain in the run content store");
  if (runCount !== report.runs || stageCount !== report.stages || resultCount !== report.results || builderCount !== report.builderLogStages) throw new Error("Release totals do not match conversion report");
  return { verification: "full-files-and-roundtrip", runs: runCount, stages: stageCount, results: resultCount, builderStages: builderCount, uniqueTexts: refs.size, aggregateWarnings: report.aggregateWarnings, benchmarkInventorySha256: release.benchmark.inventorySha256, runsInventorySha256: release.runs.inventorySha256 };
}
