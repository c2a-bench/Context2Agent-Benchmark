# C2A Bench

Static replay viewer: **GitHub Pages frontend + two public, commit-pinned Hugging Face datasets**.
No hosted server, AWS infrastructure, or runtime credentials are required.

Repository: [c2a-bench/Context2Agent-Benchmark](https://github.com/c2a-bench/Context2Agent-Benchmark).
Intended Pages URL: `https://c2a-bench.github.io/Context2Agent-Benchmark/`.
Benchmark definitions: [`observeai/c2a-bench`](https://huggingface.co/datasets/observeai/c2a-bench).
Run artifacts: [`observeai/c2a-bench-runs`](https://huggingface.co/datasets/observeai/c2a-bench-runs).
Upload revisions remain unset until the normalized datasets pass local and anonymous remote verification.

## Get started

```bash
cd viewer
npm ci
npm run check:tools
npm run test:data
python3 -m unittest discover -s scripts -p 'test_*.py'
npx playwright install chromium
npm run test:pages
```

Tests work without a real dataset or secrets. Pages deployment is disabled until explicitly enabled and
`viewer/datasets/production.json` identifies verified commits for both public repositories. Large data is never
committed to GitHub or bundled into the frontend. Do not embed a Hugging Face token in the app.

- [Viewer, publishing tools, and deployment setup](viewer/README.md)

This repository starts with one fresh commit named `initial commit`; no benchmark source history is imported.
