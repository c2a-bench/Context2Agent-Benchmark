/**
 * The doc index: for every doc in the bench's stages/<n>/docs.json, where its entry sits in that file (byte range) and
 * what the pages list about it (title, status, date, author, kind), without its text. The site reads titles from the
 * index and fetches one doc's bytes (an HTTP range request) when it is opened, instead of a whole docs.json (Skyway's
 * first stage is 43 MB).
 *
 *   npm run build:doc-index                                    # the pinned bench, from Hugging Face (pin:production runs it)
 *   npx tsx scripts/build-doc-index.ts <bench folder> [out dir]  # the pinned bench, from a local copy
 *
 * Writes <out dir>/<bench commit>/<domain>.json (default public/doc-index) for the benchmark commit pinned in
 * datasets/production.json, after checking the bench's inventory.json against the pinned one. Indexes of other
 * commits are removed. From Hugging Face it does nothing when the pinned commit's index is already there.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { docView, type DocEntry } from "../src/lib/dataset-v2";
import { parseRelease, releaseUrl } from "./data/release";
import type { Doc } from "../src/lib/types";

/** [start, end, title, status, updated, author, source, born, edited]: byte range of the entry, then its listing. */
export type DocIndexRow = [number, number, string, string, string, string, Doc["source"], number | null, number | null];
export type DocIndexFile = { format: 1; revision: string; stages: Record<string, Record<string, DocIndexRow>> };

/** The top-level entries of a JSON object, by key, with each value's byte range (end exclusive). One pass over the
 *  bytes: strings (with escapes) are skipped, depth is counted, so nested values are never parsed. */
export function entryRanges(buf: Buffer): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  let i = 0;
  const ws = () => { while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++; };
  const str = () => { const s = i; i++; while (buf[i] !== 0x22) i += buf[i] === 0x5c ? 2 : 1; i++; return JSON.parse(buf.subarray(s, i).toString("utf8")) as string; };
  ws(); if (buf[i++] !== 0x7b) throw new Error("not a JSON object");
  ws(); if (buf[i] === 0x7d) return out;
  for (;;) {
    ws(); const key = str(); ws();
    if (buf[i++] !== 0x3a) throw new Error(`no ':' after ${key}`);
    ws(); const start = i;
    let depth = 0;
    for (;;) {
      const c = buf[i];
      if (c === 0x22) { i++; while (buf[i] !== 0x22) i += buf[i] === 0x5c ? 2 : 1; i++; continue; }
      if (c === 0x7b || c === 0x5b) depth++;
      else if (c === 0x7d || c === 0x5d) { if (depth === 0) break; depth--; }
      else if (c === 0x2c && depth === 0) break;
      i++;
      if (depth === 0 && (buf[i] === 0x2c || buf[i] === 0x7d)) break;
    }
    let end = i; while (end > start && (buf[end - 1] === 0x20 || buf[end - 1] === 0x0a || buf[end - 1] === 0x0d || buf[end - 1] === 0x09)) end--;
    out.set(key, [start, end]);
    ws();
    if (buf[i] === 0x2c) { i++; continue; }
    if (buf[i] === 0x7d) return out;
    throw new Error(`unexpected byte at ${i}`);
  }
}

async function main() {
  const [bench, outDir = "public/doc-index"] = process.argv.slice(2);
  const pinned = parseRelease(JSON.parse(readFileSync("datasets/production.json", "utf8")));
  const revision = pinned.benchmark.revision;
  const dir = path.join(outDir, revision);
  if (!bench && pinned.domains.every((d) => existsSync(path.join(dir, `${d}.json`)))) {
    console.log(`doc index for ${revision.slice(0, 7)} is already there`);
    return;
  }
  // a file of the pinned bench, from the local copy or from Hugging Face
  const read = async (file: string): Promise<Buffer> => {
    if (bench) return readFile(path.join(bench, file));
    const res = await fetch(`${releaseUrl(pinned.benchmark)}/${file}`, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`${res.status} for ${file}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const inventory = createHash("sha256").update(await read("inventory.json")).digest("hex");
  if (pinned.benchmark.inventorySha256 !== inventory) throw new Error("this bench is not the pinned benchmark (inventory.json differs)");
  mkdirSync(dir, { recursive: true });
  for (const domain of pinned.domains) {
    const task = JSON.parse((await read(`${domain}/task.json`)).toString("utf8"));
    const file: DocIndexFile = { format: 1, revision, stages: {} };
    let n = 0;
    for (const s of task.stages as { index: number }[]) {
      const buf = await read(`${domain}/stages/${s.index}/docs.json`);
      const parsed = JSON.parse(buf.toString("utf8")) as Record<string, DocEntry | Doc>;
      const rows: Record<string, DocIndexRow> = {};
      for (const [p, [start, end]] of entryRanges(buf)) {
        const e = JSON.parse(buf.subarray(start, end).toString("utf8")) as DocEntry | Doc;
        if (JSON.stringify(e) !== JSON.stringify(parsed[p])) throw new Error(`${domain}/${s.index} ${p}: range does not hold its entry`);
        const d = "born" in e && !("title" in e) ? docView(p, e as DocEntry) : (e as Doc);
        rows[p] = [start, end, d.title, d.status, d.updated, d.author, d.source, d.born ?? null, d.edited ?? null];
      }
      if (Object.keys(rows).length !== Object.keys(parsed).length) throw new Error(`${domain}/${s.index}: entries missing`);
      file.stages[String(s.index)] = rows; n += Object.keys(rows).length;
    }
    const out = path.join(dir, `${domain}.json`);
    writeFileSync(out, JSON.stringify(file));
    console.log(`${domain}: ${n} docs -> ${out} (${Math.round(Buffer.byteLength(JSON.stringify(file)) / 1024)} KB)`);
  }
  // the site only reads the pinned commit's index
  for (const old of readdirSync(outDir)) if (old !== revision && /^[a-f0-9]{40}$/.test(old)) { rmSync(path.join(outDir, old), { recursive: true }); console.log(`removed the old index ${old.slice(0, 7)}`); }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) await main();
