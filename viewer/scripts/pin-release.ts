import { parseArgs } from "node:util";
import { pinRelease } from "./data/pin-release";

try {
  const { values } = parseArgs({ options: { dir: { type: "string" }, "benchmark-revision": { type: "string" }, "runs-revision": { type: "string" } } });
  if (!values.dir || !values["benchmark-revision"]) throw new Error("--dir and --benchmark-revision are required");
  console.log(JSON.stringify(await pinRelease(values.dir, values["benchmark-revision"], values["runs-revision"]), null, 2));
} catch (error) { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }
