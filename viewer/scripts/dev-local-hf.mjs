// Runs the viewer against a local copy of the two pinned HF datasets (.local-data/{benchmark,runs}; downloaded on first run).
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(".local-data"), port = 5300;
// First run: download the pinned datasets (~1 GB); `npm run dev:local-hf` again resumes an interrupted download.
if (process.argv.includes("--fetch") || !existsSync(path.join(root, ".done"))) {
  const r = spawnSync("uv", ["run", "--with", "huggingface_hub", "python3", "scripts/fetch-local-hf.py"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const release = JSON.parse(readFileSync("datasets/production.json", "utf8"));
createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!file.startsWith(root + path.sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "text/plain");
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1");
const urls = { benchmark: `http://127.0.0.1:${port}/benchmark`, runs: `http://127.0.0.1:${port}/runs` };
spawn("npx", ["vite", "--port", "5199"], { stdio: "inherit", env: { ...process.env, VITE_DATA_MODE: "published", VITE_DATA_RELEASE: JSON.stringify({ release, urls }) } });
