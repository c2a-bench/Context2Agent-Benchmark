import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { verifyMigration } from "./data/verify-migration";

try {
  const { values } = parseArgs({ options: { dir: { type: "string" }, report: { type: "string" } } });
  if (!values.dir) throw new Error("Usage: npm run verify:migration -- --dir .migration/RELEASE [--report FILE]");
  const report = await verifyMigration(values.dir);
  const output = JSON.stringify(report, null, 2) + "\n";
  if (values.report) { await mkdir(path.dirname(values.report), { recursive: true }); await writeFile(values.report, output); }
  console.log(output);
} catch (error) { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }
