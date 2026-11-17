import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodeData, DocsData, Meta, Ticket } from "../src/lib/types";
import type { JobSummary, TaskSummary } from "../src/lib/data-types";
import { DEFAULT_TASK, OLD_NAMES, runKey } from "../src/lib/data-types";

/** Repo root (parent of viewer/). Override with REPO_ROOT when cwd is not viewer/. */
export function repoRoot() {
  return process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : path.resolve(process.cwd(), "..");
}

function tasksDir() {
  return path.join(repoRoot(), "tasks");
}

// Local-only FS helpers.
const exists = (p: string) => fs.existsSync(p);
const readText = (p: string) => fs.readFileSync(p, "utf8");
const stat = (p: string) => fs.statSync(p);
const readdir = (p: string) => fs.readdirSync(p);
const readdirEnt = (p: string) => fs.readdirSync(p, { withFileTypes: true });

export type RunPaths = {
  task: string;
  job: string;
  dir: string;
  cache: string;
  builder: string;
};

/** Resolve a run key to paths. Job dir: tasks/<task>/jobs/<id>, else REPO/jobs/<id>, else JOBS_DIR/<id>. */
export function resolve(key: string): RunPaths {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`bad run ${key}`);
  const dot = key.indexOf(".");
  const named = dot > 0 ? key.slice(0, dot) : DEFAULT_TASK;
  const task = OLD_NAMES[named] ?? named;
  const job = dot > 0 ? key.slice(dot + 1) : key;
  // Neither part may climb out of the jobs folders.
  if ([task, job].some((x) => !x || x.startsWith(".") || x.includes(".."))) throw new Error(`bad run ${key}`);
  const TASKS = tasksDir();
  const canonical = path.join(TASKS, task, "jobs", job);
  const fallbackRoot = path.join(repoRoot(), "jobs", job);
  const fromEnv = process.env.JOBS_DIR ? path.join(path.resolve(process.env.JOBS_DIR), job) : null;
  const dir = exists(canonical) ? canonical : fromEnv && exists(fromEnv) ? fromEnv : fallbackRoot;
  return {
    task,
    job,
    dir,
    cache: path.join(process.cwd(), ".data", task, job),
    builder: path.join(TASKS, task, "scripts/replay_data.py"),
  };
}

const memo = new Map<string, { mtime: number; value: unknown }>();

function readJson<T>(file: string): T {
  const mtime = stat(file).mtimeMs;
  const hit = memo.get(file);
  if (hit && hit.mtime === mtime) return hit.value as T;
  const value = JSON.parse(readText(file)) as T;
  memo.set(file, { mtime, value });
  return value;
}

function tryJson<T>(file: string): T | null {
  try {
    return readJson<T>(file);
  } catch {
    return null;
  }
}

function newestResult(dir: string): number {
  let newest = 0;
  if (!exists(dir)) return 0;
  for (const trial of readdirEnt(dir)) {
    if (!trial.isDirectory()) continue;
    // Harbor writes result.json (step timings) when the run ends, after the last step's verifier files.
    const result = path.join(dir, trial.name, "result.json");
    if (exists(result)) newest = Math.max(newest, stat(result).mtimeMs);
    const steps = path.join(dir, trial.name, "steps");
    if (!exists(steps)) continue;
    for (const stage of readdir(steps)) {
      for (const name of ["results.json", "scores.json", "evidence.json", "reward.json", "docs_recall.json"]) {
        const f = path.join(steps, stage, "verifier", name);
        if (exists(f)) newest = Math.max(newest, stat(f).mtimeMs);
      }
    }
  }
  return newest;
}

/** Build replay JSON into the cache dir; returns the cache path. */
export function ensure(key: string): string {
  const r = resolve(key);
  if (!exists(r.dir)) throw new Error(`unknown run ${key} (looked in ${r.dir})`);
  if (!exists(r.builder)) throw new Error(`tasks/${r.task}/scripts/replay_data.py is missing`);
  const meta = path.join(r.cache, "meta.json");
  const metaJson = exists(meta) ? tryJson<{ stages?: number[] }>(meta) : null;
  const emptyStages = !!metaJson && Array.isArray(metaJson.stages) && metaJson.stages.length === 0;
  const stale =
    !exists(meta) ||
    emptyStages ||
    stat(meta).mtimeMs < newestResult(r.dir) ||
    stat(meta).mtimeMs < stat(r.builder).mtimeMs;
  if (stale) {
    fs.mkdirSync(r.cache, { recursive: true });
    execFileSync("python3", [r.builder, r.dir, r.cache], { stdio: "pipe", timeout: 120_000 });
  }
  return r.cache;
}

/** Build a run's logs (if needed) and return its cache dir: publish-run.ts uploads them. */
export function buildLogs(key: string): string {
  const cache = ensure(key);
  ensureBuildLogs(resolve(key));
  return cache;
}

/** The builder's logs for the Build tab (scripts/build_logs.py): builds.json, builds/<i>.json and logtexts/ shards,
 *  rebuilt when missing or older than the script or the run's result. A run without builder logs just has none. */
function ensureBuildLogs(r: RunPaths) {
  const script = path.join(repoRoot(), "scripts", "build_logs.py");
  if (!exists(script)) return;
  const out = path.join(r.cache, "builds.json");
  const stale = !exists(out) || stat(out).mtimeMs < stat(script).mtimeMs || stat(out).mtimeMs < newestResult(r.dir);
  if (!stale) return;
  try {
    execFileSync("python3", [script, r.dir, r.cache], { stdio: "pipe", timeout: 180_000 });
  } catch {
    // No trial or no logs: the Build tab says so.
  }
}

// Tasks whose instruction names the same company as another task (support-agent-knowledge reuses Redwood's docs).
const DISPLAY_NAMES: Record<string, string> = { "support-agent-knowledge": "Support Agent Knowledge", "skyway-air": "Skyway Air" };

export function listTasks(): TaskSummary[] {
  const TASKS = tasksDir();
  if (!exists(TASKS)) return [];
  return readdirEnt(TASKS)
    .filter((d) => d.isDirectory() && exists(path.join(TASKS, d.name, "task.toml")))
    .map((d) => {
      const dir = path.join(TASKS, d.name);
      const first = exists(path.join(dir, "instruction.md")) ? readText(path.join(dir, "instruction.md")).split("\n")[0] : "";
      const name = DISPLAY_NAMES[d.name] ?? first.match(/^#\s*Build an LLM agent for (.+)$/)?.[1]?.trim() ?? d.name;
      const description = readText(path.join(dir, "task.toml")).match(/^description\s*=\s*"(.*)"\s*$/m)?.[1] ?? "";
      const jobs = listJobIds(d.name);
      const sourceMd = path.join(dir, "SOURCE.md");
      const sources = exists(sourceMd)
        ? [...readText(sourceMd).matchAll(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g)].map((m) => ({
            label: m[1],
            url: m[2],
          }))
        : [];
      return { id: d.name, name, description, runs: jobs.length, latest: jobs[0] ?? null, sources };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listJobIds(task: string): string[] {
  const dirs = jobSearchDirs(task);
  const ids = new Set<string>();
  for (const jobs of dirs) {
    if (!exists(jobs)) continue;
    for (const j of readdir(jobs)) {
      // A run folder has Harbor's config.json; other folders there (e.g. arch-logs/) are not runs.
      if (stat(path.join(jobs, j)).isDirectory() && exists(path.join(jobs, j, "config.json"))) ids.add(j);
    }
  }
  return [...ids].sort().reverse();
}

function jobSearchDirs(task: string): string[] {
  const canonical = path.join(tasksDir(), task, "jobs");
  const out = [canonical];
  if (process.env.JOBS_DIR) out.push(path.resolve(process.env.JOBS_DIR));
  // Repo-root jobs/ is used when Harbor wrote outside tasks/<task>/jobs. Only the default
  // task inherits that folder so other companies do not all show the same runs.
  if (!exists(canonical) && task === DEFAULT_TASK) out.push(path.join(repoRoot(), "jobs"));
  return out;
}

function findJobDir(task: string, id: string): string | null {
  for (const root of jobSearchDirs(task)) {
    const dir = path.join(root, id);
    if (exists(dir) && stat(dir).isDirectory()) return dir;
  }
  return null;
}

type HarborResult = {
  started_at?: string;
  finished_at?: string;
  stats?: { cost_usd?: number; n_input_tokens?: number; n_cache_tokens?: number; n_output_tokens?: number };
};
type TrialResult = {
  verifier_result?: { rewards?: { reward?: number } };
  step_results?: {
    verifier_result?: { rewards?: { reward?: number } };
    agent_execution?: { started_at?: string; finished_at?: string } | null;
  }[];
};

/** The builder's thinking setting, read from its own logs on the first stage: Codex sessions record
 *  reasoning_effort (null = its default), Claude Code records effort. */
function builderThinking(trialDir: string): string | null {
  const steps = path.join(trialDir, "steps");
  if (!exists(steps)) return null;
  const first = readdir(steps).sort()[0];
  if (!first) return null;
  const files: string[] = [];
  const walk = (d: string) => {
    if (!exists(d) || files.length > 40) return;
    for (const e of readdirEnt(d)) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(jsonl?|txt)$/.test(e.name)) files.push(f);
    }
  };
  walk(path.join(steps, first, "agent"));
  const counts = new Map<string, number>();
  for (const f of files) {
    const text = readText(f).slice(0, 4_000_000);
    const codex = text.match(/"reasoning_effort"\s*:\s*(null|"(\w+)")/);
    if (codex) return codex[2] ?? "default";
    for (const m of text.matchAll(/"effort"\s*:\s*"(low|medium|high|xhigh|max)"/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) return top;
  // Gemini CLI: its own logs don't name the level; harbor's trial log holds the settings it wrote (thinkingLevel).
  const trialLog = path.join(trialDir, "trial.log");
  const gemini = exists(trialLog) ? readText(trialLog).slice(0, 4_000_000).match(/"thinkingLevel"\s*:\s*"(\w+)"/) : null;
  return gemini ? gemini[1].toLowerCase() : null;
}
type JobConfig = {
  agents?: { name?: string; model_name?: string; kwargs?: { reasoning_effort?: unknown } }[];
  /** skyway-arch: the architecture file added to every stage's instructions (tasks/skyway-arch/architectures/<name>.md). */
  extra_instruction_paths?: string[];
};

/** The bot's model from a step's results.json: the first model call names it. Read in 4 MB pieces and stop at the first
 *  match (parsing the whole file took GBs on runs whose results hold whole docs in every prompt, ~230 MB per stage). */
function firstModel(file: string): string | null {
  if (!exists(file)) return null;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4 << 20);
    let pos = 0, carry = "", inCalls = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) return null;
      pos += n;
      let text = carry + buf.toString("utf8", 0, n);
      if (!inCalls) {
        const at = text.indexOf('"model_calls"');
        if (at < 0) {
          carry = text.slice(-64);
          continue;
        }
        inCalls = true;
        text = text.slice(at);
      }
      const m = text.match(/"model"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
      carry = text.slice(-512); // a key split across two pieces is found in the next
    }
  } finally {
    fs.closeSync(fd);
  }
}

const KNOWLEDGE_PACKS = ["Rcomplete", "Rfragmented", "Rincomplete", "Rconflicting", "Rnoisy"];

function stageOrder(name: string): number {
  if (/^stage\d+$/.test(name)) return +name.slice(5);
  const i = KNOWLEDGE_PACKS.indexOf(name);
  return i >= 0 ? i : 999;
}

export function jobSummary(task: string, id: string): JobSummary | null {
  const dir = findJobDir(task, id);
  if (!dir) return null;
  const result = tryJson<HarborResult>(path.join(dir, "result.json")) ?? {};
  const config = tryJson<JobConfig>(path.join(dir, "config.json"));
  const agent = config?.agents?.[0] ?? {};
  const archFile = config?.extra_instruction_paths?.find((p) => /\/architectures\/[^/]+\.md$/.test(p));
  const architecture = archFile ? path.basename(archFile, ".md") : null;
  const scores: JobSummary["scores"] = [];
  let thinking: string | null = null;
  let score: number | null = null;
  let bot: string | null = null;
  for (const trial of readdirEnt(dir)) {
    const steps = path.join(dir, trial.name, "steps");
    if (!trial.isDirectory() || !exists(steps)) continue;
    const trialResult = tryJson<TrialResult>(path.join(dir, trial.name, "result.json"));
    // From the builder's own logs; when they don't name it (Terminus-2), the setting the run was started with.
    const effort = agent.kwargs?.reasoning_effort;
    thinking = builderThinking(path.join(dir, trial.name)) ?? (typeof effort === "string" && effort ? effort.toLowerCase() : null);
    const rewards = (trialResult?.step_results ?? [])
      .map((s) => s.verifier_result?.rewards?.reward)
      .filter((x): x is number => typeof x === "number");
    score =
      trialResult?.verifier_result?.rewards?.reward ??
      (rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : null);
    for (const stage of readdir(steps)
      .filter((s) => /^stage\d+$/.test(s) || /^R(complete|fragmented|incomplete|conflicting|noisy)$/.test(s))
      .sort((a, b) => stageOrder(a) - stageOrder(b))) {
      const raw =
        tryJson<{
          tickets?: { passed?: number; total?: number; ours?: number };
          by_group?: Record<string, { passed: number; total: number }>;
          behavior_coverage?: JobSummary["scores"][number]["behavior_coverage"];
          realization_robustness?: JobSummary["scores"][number]["realization_robustness"];
          change_sources?: JobSummary["scores"][number]["change_sources"];
        }>(path.join(steps, stage, "verifier/scores.json")) ?? {};
      const t = raw.tickets ?? {};
      scores.push({
        stage: stageOrder(stage),
        ...t,
        ...(raw.by_group ? { by_group: raw.by_group } : {}),
        ...(raw.behavior_coverage ? { behavior_coverage: raw.behavior_coverage } : {}),
        ...(raw.realization_robustness
          ? { realization_robustness: raw.realization_robustness }
          : {}),
        ...(raw.change_sources ? { change_sources: raw.change_sources } : {}),
      });
      if (!bot) bot = firstModel(path.join(steps, stage, "verifier/results.json"));
    }
    break;
  }
  // No build or run durations in the catalog: the site shows neither.
  return {
    key: runKey(task, id),
    id,
    started: result.started_at ?? null,
    finished: !!result.finished_at,
    thinking,
    architecture,
    score,
    builder: { agent: agent.name ?? null, model: agent.model_name ?? null },
    bot,
    cost: result.stats?.cost_usd ?? null,
    tokens: {
      input: result.stats?.n_input_tokens ?? null,
      cached: result.stats?.n_cache_tokens ?? null,
      output: result.stats?.n_output_tokens ?? null,
    },
    scores,
  };
}

export function listJobs(task: string): JobSummary[] {
  return listJobIds(task)
    .map((id) => jobSummary(task, id))
    .filter((j): j is JobSummary => !!j);
}

export function taskInfo(task: string): TaskSummary | null {
  return listTasks().find((t) => t.id === task) ?? null;
}

/** A run's built file on disk (built first if needed), for serving as it is: meta, tickets, passed, code, docs, or a
 *  texts/<2 hex> shard. Null when the run has no such file (passed.json of older runs, a shard with no texts). */
export function runFilePath(key: string, name: string): string | null {
  if (!/^(meta|tickets|passed|code|docs|builds)\.json$|^(texts|logtexts)\/[0-9a-f]{2}\.json$|^builds\/\d{1,3}\.json$/.test(name)) return null;
  const cache = ensure(key);
  // Build logs only when they are asked for (the Build page): building them for every run listed made the catalog slow.
  if (/^(builds|logtexts)/.test(name)) ensureBuildLogs(resolve(key));
  const file = path.join(cache, name);
  return exists(file) ? file : null;
}

export const getMeta = (key: string) => readJson<Meta>(path.join(ensure(key), "meta.json"));
export const getTickets = (key: string) => readJson<Ticket[]>(path.join(ensure(key), "tickets.json"));
export const getCode = (key: string) => readJson<CodeData>(path.join(ensure(key), "code.json"));
export const getDocs = (key: string) => readJson<DocsData>(path.join(ensure(key), "docs.json"));
/** One shard of the run's texts (texts/<2 hex>.json): runs built with them keep docs' and bot files' texts there. */
export const getTextShard = (key: string, shard: string) =>
  /^[0-9a-f]{2}$/.test(shard) ? tryJson<Record<string, string>>(path.join(ensure(key), "texts", `${shard}.json`)) ?? {} : {};
/** Passed tickets; runs built before the replay builder wrote passed.json have none. */
export const getPassed = (key: string) => tryJson<Ticket[]>(path.join(ensure(key), "passed.json")) ?? [];

/** Every ticket of the run's task as the grader defines it, with this run's result (scripts/case_data.py). Rebuilt
 *  when the script, the run's results or the task's ticket files are newer than the cached copy. */
export function getCases(key: string) {
  const r = resolve(key);
  if (!exists(r.dir)) throw new Error(`unknown run ${key} (looked in ${r.dir})`);
  const script = path.join(repoRoot(), "scripts/case_data.py");
  const out = path.join(r.cache, "cases.json");
  const tests = path.join(tasksDir(), r.task, "tests");
  // Every file the script reads: the task's own and each stage's tickets, rules and facts, the tags and the seed.
  const stages = path.join(tests, "stages");
  const staged = exists(stages)
    ? readdir(stages).flatMap((s) => ["cases.json", "rules.json", "facts.json"].map((f) => path.join(stages, s, f)))
    : [];
  const inputs = [script, ...["cases.json", "rules.json", "facts.json", "fact_tags.json", "seed/customers.json"].map((f) => path.join(tests, f)), ...staged]
    .filter(exists).map((f) => stat(f).mtimeMs);
  const stale = !exists(out) || stat(out).mtimeMs < Math.max(newestResult(r.dir), ...inputs);
  if (stale) {
    fs.mkdirSync(r.cache, { recursive: true });
    execFileSync("python3", [script, r.dir, out], { stdio: "pipe", timeout: 120_000 });
  }
  return readJson<unknown>(out);
}
