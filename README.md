# C2A Bench

C2A (Context to Agent) tests how well an AI model builds a customer support agent from a company's internal docs, and
keeps it right as the docs change. A **builder** model reads the docs and writes an agent; the **grader** sends the
agent graded support tickets, a simulated customer answers its questions, and each ticket passes or fails on what the
agent did. A **fact judge** then explains every failure.

- Benchmark data (docs, changes, tickets, seed): [`observeai/c2a-bench`](https://huggingface.co/datasets/observeai/c2a-bench)
- Results of every published run: [`observeai/c2a-bench-runs`](https://huggingface.co/datasets/observeai/c2a-bench-runs)
- This repo: the code to run the benchmark (`tasks/`, `scripts/`) and the results viewer (`viewer/`)

| Task | What it tests |
|---|---|
| `redwood-inference` | 6 stages: the docs change between stages and the builder updates its agent (290 graded tickets) |
| `support-agent-knowledge` | the same 67 tickets with 5 versions of the docs: complete, fragmented, incomplete, conflicting, noisy |
| `skyway-air` | 6 stages on a large airline doc base, with the agent's design fixed per run (6 architectures, 311 tickets) |

## Run the benchmark

### 1. Install

- Python 3.11+, [uv](https://docs.astral.sh/uv/), Docker (running)
- [Harbor](https://pypi.org/project/harbor/), which runs the stages in containers: `uv tool install harbor`

### 2. Download the data

The tasks here hold only code. Fill them with the benchmark data from Hugging Face, pinned to a commit:

```bash
uv run --with huggingface_hub python3 scripts/fetch_bench.py --revision <observeai/c2a-bench commit>
```

This writes, per task, what the builder gets (the docs, API reference, practice tickets, instructions, each stage's
doc changes, each knowledge pack, Skyway's architectures) and what the grader reads (the graded tickets, rules, facts
and seed). The downloaded files are git-ignored.

### 3. Keys and settings

```bash
cp .env.example .env
```

Fill in the provider keys your models need (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`). `BOT_MODEL` is the model every agent uses (published results: `openai/gpt-5.6-sol`, which also
plays the customer), so builders compare on what they built, not on the model behind it. The fact judge uses
`JUDGE_MODEL` / `FACTS_MODEL` (default `openai/gpt-6.1-sol`).

### 4. Run

One command runs every stage of a task and then judges it:

```bash
# Codex
bash scripts/run_with_judge.sh redwood-inference -a codex -m openai/gpt-6.1-sol \
    --agent-setup-timeout-multiplier 3 --ak web_search=disabled --ak reasoning_effort=high

# Claude Code
bash scripts/run_with_judge.sh redwood-inference -a claude-code -m anthropic/claude-opus-5-5 \
    --agent-setup-timeout-multiplier 3 --ak disallowed_tools=WebSearch,WebFetch --ak reasoning_effort=high

# pi (any LiteLLM model, e.g. through OpenRouter)
bash scripts/run_with_judge.sh redwood-inference -a pi -m openrouter/z-ai/glm-5.3 \
    --agent-setup-timeout-multiplier 3 --ak thinking=high
```

Use `support-agent-knowledge` the same way. For `skyway-air`, give the architecture (a name from
`tasks/skyway-air/architectures/`, or `all` for all six at once):

```bash
bash scripts/run_arch.sh wiki-index -a codex -m openai/gpt-6.1-sol \
    --agent-setup-timeout-multiplier 3 --ak web_search=disabled --ak reasoning_effort=high
```

These are the settings of the published runs. The builder's web tools are off, so it works only from the docs.

### What happens

1. **Run** (Harbor): for each stage, the builder builds or updates the agent in its container; then the grader
   (`tasks/<task>/tests/`) resets the support system from the seed, plays each ticket with the simulated customer,
   and checks the end state, the agent's calls and its reply. The run lands in `tasks/<task>/jobs/<run>/`.
2. **Fact judge**, automatically once the run finishes:
   - `scripts/fact_metrics.py`: a model reads the agent's files and decides which facts from the docs it has (rule
     recall and precision), and another reads each conversation for the customer facts the agent obtained. Every failed
     ticket gets its reasons: the builder missed a fact, the agent misused it, or the failure was on the harness's side.
   - `scripts/fact_run.py`: writes `tasks/<task>/jobs/<run>-facts/`, the run with those reasons. This is the result
     to read. Pass/fail and scores are the run's own.

   The judge has two modes: `paste` (default; the agent's files go into the judge's prompt) and `folder` (Codex CLI or
   Claude Code in Docker opens the agent's files itself; used for Skyway, whose agents hold indexes and graphs).
   At most `JUDGE_SLOTS` judges (default 2) run at once on the machine.

Useful variants:

```bash
bash scripts/run_with_judge.sh --judge-only tasks/<task>/jobs/<run>         # judge a finished run again
SKIP_JUDGE=1 bash scripts/run_with_judge.sh redwood-inference ...            # run without judging
python3 scripts/regrade.py --help                                           # re-grade chosen tickets of a finished run
```

`regrade.py` re-tests only some tickets with the same agent (no rebuild), e.g. tickets lost on the harness's side
(a model provider timing out). Then judge the run again with `--judge-only`.

### Check the grader

Each stage ships hand-written outcomes that must pass or fail (`steps/<stage>/check/`, `tests/fixtures/`):

```bash
python3 tasks/redwood-inference/steps/stage1/check/check.py
```

## Viewer

Static replay viewer: **GitHub Pages frontend + the two public, commit-pinned Hugging Face datasets**.
No hosted server, AWS infrastructure, or runtime credentials are required.

Intended Pages URL: `https://c2a-bench.github.io/Context2Agent-Benchmark/`.
Upload revisions remain unset until the normalized datasets pass local and anonymous remote verification.

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
