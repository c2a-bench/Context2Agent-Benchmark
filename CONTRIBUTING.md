# Contributing

Bugs, fixes and new tasks: open an issue first, then a PR. Check code changes with
`python3 tasks/redwood-inference/steps/stage1/check/check.py` and, for the site, `cd viewer && npm run test:data`.

## Submit results

Run C2A with your builder model or harness and send us the runs. We check them and add them to the leaderboard.

### 1. Run

Follow the [README](README.md#run-the-benchmark) (install, download the data at the pinned revision, keys), then run
each task with the command for your harness. Submit the `-facts` folders: `<run>-facts` is the judged copy of the run
that `run_with_judge.sh` writes beside it.

### 2. Rules

A **standard** submission follows all of these. Anything else is labelled **custom** on the leaderboard (say what you
changed in `notes`).

- Pinned benchmark revision `76e9806`; `tasks/` and the grader unchanged.
- Every stage of each task you submit. Skyway counts only with all six architectures, the knowledge packs with all five.
- The same builder model, harness and settings for every task.
- `BOT_MODEL` (`openai/gpt-5.6-sol`) and the judge (`openai/gpt-6.1-sol`) left at their defaults, so builders compare on
  what they built.
- Builder web tools off, reasoning effort high (the flag differs per harness; see the README examples).
- The builder model was not trained on the benchmark's tickets or facts.

### 3. Failed tickets

A ticket lost on our side or the provider's (a sandbox that never started, a provider that dropped the call) may be
graded again with `python3 scripts/regrade.py --help`. A ticket the agent got wrong may not. Judge the run again with
`--judge-only` afterwards.

### 4. Describe it

Add `submissions/<model>-<org>-<yyyy-mm-dd>/submission.json`:

```json
{
  "organization": "Your org",
  "contact": "name@example.com",
  "builder_model": "provider/model-id",
  "harness": "codex | claude-code | pi | other",
  "reasoning_effort": "high",
  "benchmark_revision": "76e9806cbd77860265fab7c3473e94860c5014bb",
  "standard": true,
  "runs": [
    "tasks/redwood-inference/jobs/<run>-facts",
    "tasks/skyway-air/jobs/<arch-run>-facts (one per architecture)",
    "tasks/support-agent-knowledge/jobs/<run>-facts"
  ],
  "runs_url": "link to the uploaded run folders (a Hugging Face dataset, a bucket or a zip)",
  "notes": ""
}
```

### 5. Check and send it

```bash
python3 scripts/validate_submission.py submissions/<name>/submission.json --runs-root <where your run folders are>
```

It checks the fields, the pinned revision, that every run is a judged `-facts` folder with all its stages, and that each task is complete. Fix what it lists, then open a PR with that file. We check the runs, re-grade a sample of tickets, then publish them to
[observeai/c2a-bench-runs](https://huggingface.co/datasets/observeai/c2a-bench-runs). The leaderboard updates the next
time the site is pinned to that dataset (`npm run pin:production` in `viewer/`).
