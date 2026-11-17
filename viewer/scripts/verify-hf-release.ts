import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseRelease } from "./data/release";
import { parseSelection } from "./data/huggingface";
import { verifyRemoteDataset, verifyRemoteRelease } from "./data/verify-remote-release";

try {
  const { values } = parseArgs({ options: { manifest: { type: "string", default: "datasets/production.json" }, side: { type: "string" }, report: { type: "string" } } });
  const raw = JSON.parse(await readFile(values.manifest, "utf8"));
  let result;
  if (values.side) {
    if (!["benchmark", "runs"].includes(values.side) || raw.schemaVersion !== 2) throw new Error("--side must be benchmark or runs for a v2 release");
    const ref = parseSelection({ ...raw[values.side], schemaVersion: 1, provider: "huggingface" });
    result = await verifyRemoteDataset(ref, values.side as "benchmark" | "runs");
  } else result = await verifyRemoteRelease(parseRelease(raw));
  const output = JSON.stringify(result, null, 2) + "\n";
  if (values.report) { await mkdir(path.dirname(values.report), { recursive: true }); await writeFile(values.report, output); }
  console.log(output);
} catch (error) { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }
