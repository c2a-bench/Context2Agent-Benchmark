// Point the site at the current Hugging Face data: one command after publishing to either dataset.
//
//   npm run pin:production                                   # both datasets at their latest main
//   npm run pin:production -- --runs-revision <commit>       # a given commit (also --benchmark-revision)
//   npm run pin:production -- --full                         # also download every file and check its SHA-256
//
// Writes datasets/production.json (the commits the site is built with) after checking, without a token:
//   - both commits exist and their inventory.json downloads anonymously (its SHA-256 is pinned too);
//   - every run in the runs dataset (data/<domain>.jsonl) points to exactly this benchmark commit and inventory;
//   - with --full, every file of both datasets matches its inventory (verifyRemoteDataset).
// Then commit and push datasets/production.json: the Pages workflow rebuilds and deploys the site.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { parseRelease, releaseUrl } from "./data/release";
import { repositoryId } from "./data/huggingface";
import { verifyRemoteDataset } from "./data/verify-remote-release";

const MANIFEST = "datasets/production.json";
const { values } = parseArgs({ options: {
  "benchmark-revision": { type: "string", default: "main" }, "runs-revision": { type: "string", default: "main" },
  full: { type: "boolean" }, help: { type: "boolean" },
} });
if (values.help) { console.log("Usage: npm run pin:production [-- --benchmark-revision <commit|main>] [--runs-revision <commit|main>] [--full]"); process.exit(0); }

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res;
};
/** A branch or commit of a public dataset as its full commit SHA (the Hub API, no token). */
async function commitOf(repository: string, revision: string) {
  if (/^[a-f0-9]{40}$/.test(revision)) return revision;
  const info = await (await get(`https://huggingface.co/api/datasets/${repositoryId(repository)}/revision/${encodeURIComponent(revision)}`)).json() as { sha?: string };
  if (!info.sha || !/^[a-f0-9]{40}$/.test(info.sha)) throw new Error(`No commit for ${repository}@${revision}`);
  return info.sha;
}

try {
  const current = JSON.parse(await readFile(MANIFEST, "utf8"));
  const domains: string[] = current.domains;
  const ref = async (side: "benchmark" | "runs", revision: string) => {
    const repository = repositoryId(current[side].repository);
    const commit = await commitOf(repository, revision);
    const base = releaseUrl({ repository, revision: commit, path: "", inventorySha256: "0".repeat(64) });
    const res = await fetch(`${base}/inventory.json`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`${repository}@${commit.slice(0, 7)} has no inventory.json (${res.status}): nothing published there yet?`);
    const inventory = Buffer.from(await res.arrayBuffer());
    return { repository, revision: commit, path: "", inventorySha256: createHash("sha256").update(inventory).digest("hex") };
  };
  const benchmark = await ref("benchmark", values["benchmark-revision"]!);
  const runs = await ref("runs", values["runs-revision"]!);
  const release = parseRelease({ schemaVersion: 2, provider: "huggingface", domains, benchmark, runs });

  // every run must be scored against exactly this benchmark (the site refuses runs that are not)
  let rows = 0;
  const wrong: string[] = [];
  for (const domain of domains) {
    const text = await (await get(`${releaseUrl(runs)}/data/${domain}.jsonl`)).text();
    for (const line of text.trim().split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { id: string; benchmark_revision: string | null; benchmark_inventory_sha256: string };
      rows++;
      if (row.benchmark_revision !== benchmark.revision || row.benchmark_inventory_sha256 !== benchmark.inventorySha256) wrong.push(`${domain}/${row.id}`);
    }
  }
  if (wrong.length) throw new Error(`${wrong.length} of ${rows} runs point to another benchmark commit (e.g. ${wrong.slice(0, 3).join(", ")}): re-link the runs to ${benchmark.revision} and publish them first`);
  if (values.full) for (const side of ["benchmark", "runs"] as const) console.log(JSON.stringify(await verifyRemoteDataset(release[side], side)));

  const changed = current.benchmark.revision !== benchmark.revision || current.runs.revision !== runs.revision;
  await writeFile(MANIFEST, JSON.stringify(release, null, 2) + "\n");
  console.log(`benchmark ${benchmark.repository}@${benchmark.revision.slice(0, 7)}  runs ${runs.repository}@${runs.revision.slice(0, 7)}  (${rows} runs, all linked)`);
  console.log(changed ? `${MANIFEST} updated. Publish the site:\n  git add viewer/${MANIFEST} && git commit -m "Site: pin datasets" && git push` : `${MANIFEST} already points here; nothing to publish.`);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
