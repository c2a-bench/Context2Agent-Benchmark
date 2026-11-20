# Contributing

## Submit results

Run C2A with your builder model or harness and send us the runs. We check them and add them to the leaderboard.

### 1. Run the benchmark

Set up and download the data as in the [README](README.md#run-the-benchmark), then run each task with the published settings:

```bash
# Redwood Inference or Knowledge perturbations
bash scripts/run_with_judge.sh redwood-inference -a codex -m openai/gpt-6.1-sol \
    --agent-setup-timeout-multiplier 3 --ak web_search=disabled --ak reasoning_effort=high

# Skyway Air: one architecture, or "all" for the six
bash scripts/run_arch.sh all -a codex -m openai/gpt-6.1-sol \
    --agent-setup-timeout-multiplier 3 --ak web_search=disabled --ak reasoning_effort=high
```

Each run lands in `tasks/<task>/jobs/<run>/`. The judge writes `<run>-facts/` beside it.

### 2. Check the rules

- Use the benchmark at the pinned revision `76e9806` and leave `tasks/` and the grader unchanged.
- Run every stage of each task you submit. Skyway counts only with all six architectures, the knowledge packs with all five.
- Every support agent and the simulated customer run on `BOT_MODEL` (`openai/gpt-5.6-sol`), so builders compare on what they built.
- Builder web tools off, reasoning effort high.
- Let the fact judge finish: submit the `-facts` run folders, not only the raw runs.

### 3. Describe the submission

Put a `submission.json` next to your run folders:

```json
{
  "organization": "Your org",
  "contact": "name@example.com",
  "builder_model": "provider/model-id",
  "harness": "codex | claude-code | pi | other",
  "reasoning_effort": "high",
  "benchmark_revision": "76e9806cbd77860265fab7c3473e94860c5014bb",
  "tasks": ["redwood-inference", "skyway-air", "support-agent-knowledge"],
  "runs": ["tasks/redwood-inference/jobs/<run>-facts"],
  "notes": "anything we should know"
}
```

### 4. Send it

[Open an issue](https://github.com/c2a-bench/Context2Agent-Benchmark/issues/new?title=Result%20submission%3A%20%3Cmodel%3E%20%2B%20%3Charness%3E) titled `Result submission: <model> + <harness>`, with `submission.json` and the run folders attached or linked (a Hugging Face dataset, a bucket or a zip).

We re-grade a sample of tickets, then publish the runs to [observeai/c2a-bench-runs](https://huggingface.co/datasets/observeai/c2a-bench-runs). The leaderboard updates when the site is next pinned to that dataset.
