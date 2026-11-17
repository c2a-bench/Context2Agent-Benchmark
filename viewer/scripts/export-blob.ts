import { parseArgs } from "node:util";
import { blobSource } from "./data/blob";
import { exportSnapshot } from "./data/export";
import { fingerprint } from "./data/inventory";

const { values } = parseArgs({ options: {
  snapshot: { type: "string" }, out: { type: "string" }, reuse: { type: "string" },
  prefix: { type: "string", default: process.env.BLOB_PREFIX || "observe-bench" },
  concurrency: { type: "string", default: "4" }, "inventory-only": { type: "boolean" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("Usage: npm run export:blob -- --inventory-only\n       npm run export:blob -- --snapshot test-v1 [--out .replay-exports/test-v1] [--reuse .replay-exports/previous]\nPause Blob publishing. Local export only: no dataset is created or uploaded. Requires BLOB_READ_WRITE_TOKEN. Reads .env.local if present.");
} else {
  try {
    const source = blobSource(values.prefix);
    if (values["inventory-only"]) {
      const objects = await source.list();
      console.log(JSON.stringify({ prefix: values.prefix, sourceFingerprint: fingerprint(objects), objectCount: objects.length, totalBytes: objects.reduce((n, entry) => n + entry.size, 0), objects }, null, 2));
    } else {
      if (!values.snapshot) throw new Error("--snapshot is required");
      console.log(JSON.stringify(await exportSnapshot({ source, dir: values.out || `.replay-exports/${values.snapshot}`, snapshot: values.snapshot, sourcePrefix: values.prefix, reuse: values.reuse, concurrency: Number(values.concurrency), log: console.log }), null, 2));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
