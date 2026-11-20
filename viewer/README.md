# C2A replay viewer

GitHub Pages frontend: [`c2a-bench/c2a-bench`](https://github.com/c2a-bench/c2a-bench).
Data is split into two public, ungated Hugging Face datasets. No hosted server, Space, or runtime tokens.

## Canonical data layout

**`observeai/c2a-bench` — shared benchmark definitions**

```text
README.md                          dataset card/license and link to runs
inventory.json                     sizes and SHA-256 checksums
<domain>/task.json                  metadata and named stages
<domain>/stages/<n>/docs.json        complete initial corpus, then new/edited docs
<domain>/stages/<n>/changes.json     changes, patches, rule_changes, new_docs, deleted
<domain>/stages/<n>/cases.json       complete stage case definitions, without results
```

Domains: `redwood-inference`, `support-agent-knowledge`, `skyway-air` (canonical mapping of source
`skyway-arch`). Knowledge packs are named independent conditions (`Rcomplete`, `Rfragmented`,
`Rincomplete`, `Rconflicting`, `Rnoisy`) with `docs_mode: snapshot`, not chronological deltas.

**`observeai/c2a-bench-runs` — execution artifacts**

```text
README.md                          HF configs pointing to data/*.jsonl
inventory.json
data/<domain>.jsonl               one generated leaderboard row per run
<domain>/<job>/run.json             run metadata + pinned benchmark provenance
<domain>/<job>/stages/<n>/stage.json scores, builder summary, timing, log availability
<domain>/<job>/stages/<n>/results.json all graded cases, including missing traces
<domain>/<job>/stages/<n>/code.json  files, knowledge, and previous-stage changes
<domain>/<job>/stages/<n>/builder.json optional redacted normalized builder events
content/texts/<prefix>.json         globally deduplicated code/log text by full SHA-256
```

Documents have full text in the benchmark repo. Run-side code/log references resolve against the shared
content store. Binary artifacts remain explicitly metadata-only if that is all the source contains.
Builder exports are normalized events, not a claim to contain original system prompts/full trajectories.
Missing code, traces, metrics, or timing are kept missing; they are never fabricated.

The published catalog's overall score is retained as `run.score` (`published_trial_reward`). It is not
replaced by the pooled pass rate or mean stage reward. Differences are reported as `aggregateWarnings`.
Case-result `grading` is separate from conversation failures and `replayVerdict`.

## Run locally

```bash
npm ci
npm run dev:local-hf     # downloads the pinned datasets to .local-data on first run, then serves http://localhost:5199/
```

Tests (no real data needed): `npm run test:data`, then `npx playwright install chromium && npm run test:pages`
(with an existing Chrome: `PLAYWRIGHT_CHANNEL=chrome npm run test:pages`). Python tests:
`python3 -m unittest discover -s scripts -p 'test_*.py'`. The tests convert fixtures into the real two-repo layout
and cover Pages base paths, queries, anchors, Monaco, workers and empty-code stages.

## Convert the current Blob catalog locally

Keep `BLOB_READ_WRITE_TOKEN` in `.env.local` or the shell. Pause publishing while converting.

```bash
npm run migrate:blob -- --id RELEASE_ID --expected-runs 50 --license bsd \
  --benchmark-repo observeai/c2a-bench --runs-repo observeai/c2a-bench-runs
npm run verify:migration -- --dir .migration/RELEASE_ID --report .reports/validation.json
```

Review the expected run count against the live catalog; it is an explicit guard, not a fixed benchmark
size. Only cataloged runs are selected. Archives/legacy aliases outside the catalog are excluded and
never deleted. The converter pins catalog/source versions and refuses to complete if active source files
change. Use a new ID/output directory after source changes; the same unchanged snapshot can be resumed.
It caches/reuses text by hash, bounds downloads, and stops if free disk would fall below 512 MiB.

Outputs are `.migration/RELEASE_ID/{benchmark,runs}/`, `release.json`, and `conversion-report.json`.
They are gitignored and never included in Pages. Full validation checks file inventories, every content
reference, reconstructed document snapshots, stage scores, all case results, interaction projections,
and code snapshots. Review warnings and any credential-like content before public upload.

`--license` must match the approved existing HF dataset cards. The example `bsd` preserves the current
cards; do not invent/change a license for a different team's dataset.

## Publish only after validation

```bash
python3 -m venv .venv-hf
.venv-hf/bin/pip install -r scripts/requirements-hf.txt
# Export a dataset-scoped HF_TOKEN with write access to BOTH repositories.
.venv-hf/bin/python scripts/publish-release.py --dir .migration/RELEASE_ID --manifest datasets/candidate.json
npm run verify:hf -- --manifest datasets/candidate.json
```

Repositories are configurable via migration `--benchmark-repo` / `--runs-repo`, or `HF_BENCHMARK_REPO` /
`HF_RUNS_REPO`. There is no default dataset: explicit targets are required. They must already exist,
be public, ungated, and appropriately licensed. The publisher never creates a repo or changes its visibility.

Publication order: validate locally → upload benchmark → verify its immutable commit anonymously → pin
that SHA in every run → regenerate JSONL/inventory → upload runs → anonymously verify all bytes in
both repos → produce a selectable candidate. Until then `release.json` has null revisions and cannot
build/deploy. Existing frontend releases stay pinned to their previous commits throughout uploading.

Large-folder uploading uses local `.cache/huggingface/` for resumption; this cache is excluded from release
inventories/uploads. Unexpected remote files block publishing. `--replace-managed` explicitly permits
removing retired files only in managed domain/data/content prefixes; it never removes unknown root files.
Public staging/uploads are already public—review sensitive data and rights BEFORE uploading.

## GitHub Pages

Review/copy a fully verified candidate into `datasets/production.json`. It pins both repo commits and
inventory hashes. No moving branches, Blob fallback, tokens, or one-repo compatibility mode are used.

```bash
VITE_BASE_PATH=/c2a-bench/ npm run build:pages
npm run smoke:pages -- --url https://c2abench.com/
```

Settings → Pages → Source → GitHub Actions. Restrict `github-pages` to main, then set repository variable
`VIEWER_PAGES_ENABLED=true` only when ready. The frontend workflow has no data credentials. It derives
the repository/custom-domain base, checks public data/CORS, deploys, and records both versions.
Existing Skyway task/run links redirect to the canonical `skyway-air` domain when the job is selected.

Optional protected data workflow: environment `huggingface-data`, secrets `BLOB_READ_WRITE_TOKEN` and
`HF_TOKEN`, opt-in `HF_DATA_PUBLISH_ENABLED=true`, required repository variables `HF_BENCHMARK_REPO` /
`HF_RUNS_REPO`, and `HF_DATASET_LICENSE`.
Hosted runners lose resumable caches between jobs; use a durable machine for large exports. It never
auto-commits the candidate or enables Pages. Blob authoring `npm run publish`/local-job dev remain
optional original-source tools and require original task/job inputs; they are not deployed servers.

Rollback means reverting the approved app/release configuration and rebuilding Pages; keep referenced
HF commits available. Test against the REAL public HF/CDN endpoint after publishing—local fixtures alone
cannot certify external CORS/account limits. Review outstanding npm audit advisories before production.
