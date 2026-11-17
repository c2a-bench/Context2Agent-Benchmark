import { parseArgs } from "node:util";
import { verifyLocal } from "./data/export";

try {
  const { values } = parseArgs({ options: { dir: { type: "string" } } });
  if (!values.dir) throw new Error("Usage: npm run verify:export -- --dir .replay-exports/test-v1");
  const { complete, inventory } = await verifyLocal(values.dir);
  console.log(JSON.stringify({ ...complete, objectCount: inventory.objects.length, totalBytes: inventory.totalBytes, verification: "full-local-sha256" }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
