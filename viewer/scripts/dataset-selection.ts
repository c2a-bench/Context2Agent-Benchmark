import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseRelease } from "./data/release";
import { repositoryId } from "./data/huggingface";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "allow-unconfigured": { type: "boolean" } } });
  const raw = JSON.parse(await readFile(positionals[0] || "datasets/production.json", "utf8"));
  const pending = raw.schemaVersion === 2 && raw.provider === "huggingface" && Array.isArray(raw.domains) && raw.domains.length && [raw.benchmark, raw.runs].every((ref) => ref && typeof ref.repository === "string" && ref.revision === null && ref.inventorySha256 === null && ref.path === "");
  if (values["allow-unconfigured"] && pending) {
    repositoryId(raw.benchmark.repository); repositoryId(raw.runs.repository);
    if (raw.benchmark.repository === raw.runs.repository) throw new Error("Use distinct repositories");
    console.log("Two-repository configuration is ready; verified upload revisions are deliberately pending");
  } else console.log(JSON.stringify(parseRelease(raw), null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
