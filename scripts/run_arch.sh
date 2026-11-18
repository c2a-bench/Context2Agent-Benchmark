#!/usr/bin/env bash
# Run skyway-air with one architecture fixed: its file from tasks/skyway-air/architectures/ is appended to every
# stage's instructions (Harbor's --extra-instruction-path), then the run is fact-judged (scripts/run_with_judge.sh), in
# folder mode (JUDGE_MODE=folder: the judge opens the bot's files itself) unless JUDGE_MODE is set. One command runs
# and judges; the judges take turns (JUDGE_SLOTS, default 2 at once).
#
#   bash scripts/run_arch.sh <architecture> [harbor run options]
#   bash scripts/run_arch.sh all [harbor run options]      # every architecture at once
#   bash scripts/run_arch.sh raw-index -a claude-code -m anthropic/claude-opus-5-5 --agent-setup-timeout-multiplier 3 \
#       --ak disallowed_tools=WebSearch,WebFetch
#
# The architecture is the file's name without .md (raw-index, raw-terminal, wiki-index, wiki-terminal, graph-query, prompt-workflows, ...). Adding one is adding a file;
# "all" picks it up. Harbor records the file's path in each run's config (extra_instruction_paths), so every run says
# which architecture it had.
#
# "all" answers Harbor's start-up question itself (-y), since its runs are in the background, and starts one run per architecture together (a few seconds apart, so Harbor's timestamped run folders differ) and
# waits for all of them; each run's output goes to tasks/skyway-air/jobs/arch-logs/<time>-<architecture>.log. To stay
# under Daytona's 250-CPU limit, each run grades with fewer workers: 240 / (CPU per ticket x runs), at most 25, the
# CPU per ticket being TICKET_SANDBOX_CPU (default 4: 6 runs -> 10 each, 6 x 10 x 4 = 240 CPU). The builders and graders run in Docker on this machine, not on Daytona.
# Nothing else should use Daytona meanwhile. Set VERIFIER_WORKERS yourself to override it. A run that
# fails is reported at the end; the others are not stopped.
set -uo pipefail

# Every skyway-air run is judged in folder mode: its bots hold graphs, indexes and many files a pasted prompt cannot.
export JUDGE_MODE="${JUDGE_MODE:-folder}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TASK="${ARCH_TASK:-skyway-air}"
DIR="$REPO/tasks/$TASK/architectures"
# A read loop, not mapfile: macOS ships bash 3.2, which has no mapfile.
ARCHS=()
while IFS= read -r a; do ARCHS+=("$a"); done < <(cd "$DIR" && ls ./*.md 2>/dev/null | sed 's|^\./||; s|\.md$||')

usage() {
  echo "usage: bash scripts/run_arch.sh <architecture|all> [harbor run options]" >&2
  echo "architectures: ${ARCHS[*]:-}" >&2
  exit 2
}

run_one() {  # architecture, then harbor options
  local arch="$1"; shift
  # The grader reads it (task.toml [verifier.env]) to check the bot was built with this architecture.
  ARCHITECTURE="$arch" bash "$REPO/scripts/run_with_judge.sh" "$TASK" --extra-instruction-path "$DIR/$arch.md" "$@"
}

arch="${1:-}"
[ -n "$arch" ] || usage
shift

if [ "$arch" != "all" ]; then
  [ -f "$DIR/$arch.md" ] || usage
  run_one "$arch" "$@"
  exit $?
fi

n=${#ARCHS[@]}
[ "$n" -gt 0 ] || usage
cpu="${TICKET_SANDBOX_CPU:-4}"
workers=$(( 240 / (cpu * n) )); [ "$workers" -gt 25 ] && workers=25; [ "$workers" -lt 1 ] && workers=1
export VERIFIER_WORKERS="${VERIFIER_WORKERS:-$workers}"
LOGS="$REPO/tasks/$TASK/jobs/arch-logs"
mkdir -p "$LOGS"
stamp=$(date '+%Y-%m-%d__%H-%M-%S')
echo "== starting $n architectures at once (${ARCHS[*]}), $VERIFIER_WORKERS grading workers each; logs in ${LOGS#"$REPO"/}"
pids=()
for a in "${ARCHS[@]}"; do
  # -y: Harbor asks "Proceed? (Y/n)" about the environment variables a task reads; a background run cannot answer, so
  # without it every run stops at once ("Aborted."). No stdin either, so nothing else can wait on a question.
  run_one "$a" -y "$@" < /dev/null > "$LOGS/$stamp-$a.log" 2>&1 &
  pids+=("$!")
  echo "   $a: pid $!, log ${LOGS#"$REPO"/}/$stamp-$a.log"
  sleep 5
done
failed=()
for i in "${!ARCHS[@]}"; do
  wait "${pids[$i]}" || failed+=("${ARCHS[$i]}")
done
if [ ${#failed[@]} -gt 0 ]; then
  echo "== done; failed: ${failed[*]} (see their logs; the others finished)"
  exit 1
fi
echo "== done; all $n architectures finished"
