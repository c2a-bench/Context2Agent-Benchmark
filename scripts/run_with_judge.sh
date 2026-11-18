#!/usr/bin/env bash
# Start a run, then fact-grade it as soon as it finishes (fact_metrics.py, then fact_run.py for the -facts copy).
#
#   bash scripts/run_with_judge.sh <task> [harbor run options]
#   bash scripts/run_with_judge.sh redwood-inference -a codex -m openai/gpt-5.6-sol --agent-setup-timeout-multiplier 3 \
#       --ak web_search=disabled --ak reasoning_effort=high
#   bash scripts/run_with_judge.sh --judge-only tasks/<task>/jobs/<run>     # an existing run
#
# The run is the same `harbor run -p tasks/<task> -o tasks/<task>/jobs --env-file .env ...` as in the README, named
# like Harbor's default (a timestamp) unless --job-name is given, so the judge grades this run's folder and no other.
# The judge runs after its last stage, on this machine, with the keys in .env (JUDGE_MODEL / FACTS_MODEL, default
# GPT-6.1-sol at high effort; a folder judge is Codex CLI in Docker), at most JUDGE_SLOTS (default 2) at once on this machine. It needs uv (for litellm). Set SKIP_JUDGE=1 to only run. Tasks without tests/facts.json
# are not judged. Exit code: Harbor's if it failed, else the judge's.
# KEYS_FROM_ENV=1 takes every key from the environment instead of .env (run it inside `infisical run ... --`): Harbor
# loads --env-file with override, so a stale key in .env would otherwise replace the one Infisical injects.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
if [ "${KEYS_FROM_ENV:-}" = 1 ]; then
  ENV_ARGS=()
  [ -n "${OPENAI_API_KEY:-}" ] || { echo "KEYS_FROM_ENV=1 but OPENAI_API_KEY is not set (run inside infisical run)" >&2; exit 1; }
else
  [ -f .env ] || { echo "no .env in $REPO (copy .env.example)" >&2; exit 1; }
  ENV_ARGS=(--env-file "$REPO/.env")
fi

finished() {  # the path goes in as an argument, never into the code
  python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("finished_at") else 1)' \
    "$1/result.json" 2>/dev/null
}

judge() {
  local job="$1" task
  task=$(basename "$(dirname "$(dirname "$job")")")
  if [ ! -f "tasks/$task/tests/facts.json" ]; then
    echo "== $task has no tests/facts.json: not fact-graded, no judge"; return 0
  fi
  if ! finished "$job"; then
    echo "== $job did not finish: no judge (run it later with --judge-only)" >&2; return 1
  fi
  echo "== judging $job"
  # Each step returns on failure itself: errexit is off inside a function called from `... || status=$?`.
  ( if [ "${KEYS_FROM_ENV:-}" != 1 ]; then set -a; . ./.env; set +a; fi
    uv run --quiet --no-project --with litellm==1.103.2 python3 scripts/fact_metrics.py "$job" || exit $?
    python3 scripts/fact_run.py "$job" || exit $? ) || return $?
}

# At most JUDGE_SLOTS judges (default 2) at once on this machine, across every run_with_judge.sh: a folder judge is
# Claude Code in Docker, and six at once ran this machine out of memory. A judge waits for a free slot: a lock folder in
# one fixed folder of the user's own (not TMPDIR, which differs between runs; not a shared /tmp). mkdir is atomic on
# macOS and Linux alike (no flock, no bash-4 `exec {fd}`: macOS has neither). The slot holds its owner's PID; it is
# freed when its judge ends or the script exits, and a slot whose owner is gone (killed with -9) is taken over.
# A task with no judge (no tests/facts.json) takes none.
SLOT_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/run_with_judge"
held_slot=""
take_slot() {  # slot folder; 0 when this script now holds it
  local slot="$1" owner
  if mkdir "$slot" 2>/dev/null; then
    echo $$ > "$slot/pid"; held_slot="$slot"; return 0
  fi
  owner=$(cat "$slot/pid" 2>/dev/null || true)
  # No pid yet: its owner is between mkdir and writing it, so the slot is held.
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    rm -rf "$slot"
    if mkdir "$slot" 2>/dev/null; then
      echo $$ > "$slot/pid"; held_slot="$slot"; return 0
    fi
  fi
  return 1
}
judge_in_slot() {
  local job="$1" slots="${JUDGE_SLOTS:-2}" i s waited=""
  [ -f "tasks/$(basename "$(dirname "$(dirname "$job")")")/tests/facts.json" ] || { judge "$job"; return; }
  case "$slots" in ''|*[!0-9]*) slots=2 ;; esac
  slots=$((10#$slots))  # decimal: 08 is eight, not a bad octal number
  [ "$slots" -gt 0 ] || slots=2
  mkdir -p "$SLOT_DIR"
  while :; do
    for ((i = 0; i < slots; i++)); do
      if take_slot "$SLOT_DIR/judge-slot.$i.lock"; then
        echo "== judge slot $((i + 1)) of $slots"
        judge "$job" && s=0 || s=$?
        rm -rf "$held_slot"; held_slot=""
        return "$s"
      fi
    done
    [ -n "$waited" ] || { echo "== waiting for a judge slot ($slots in use)"; waited=1; }
    sleep 20
  done
}

name_lock=""
cleanup() {
  [ -z "$held_slot" ] || rm -rf "$held_slot"
  [ -z "$name_lock" ] || rmdir "$name_lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT   # run the EXIT trap on Ctrl-C and kill too
trap 'exit 143' TERM

if [ "${1:-}" = "--judge-only" ]; then
  [ -d "${2:-}" ] || { echo "usage: run_with_judge.sh --judge-only tasks/<task>/jobs/<run>" >&2; exit 1; }
  judge_in_slot "$(cd "$2" && pwd)"
  exit
fi

task="${1:?usage: run_with_judge.sh <task> [harbor run options]}"; shift
[ -d "tasks/$task" ] || { echo "no task tasks/$task" >&2; exit 1; }
jobs="$REPO/tasks/$task/jobs"
mkdir -p "$jobs"

# This run's own folder name: the one given with --job-name, else Harbor's timestamp format (made unique here).
name=""
args=("$@")
# ${args[@]+...}: bash 3.2 (macOS) calls an empty array unbound under set -u.
for i in ${args[@]+"${!args[@]}"}; do
  case "${args[$i]}" in
    --job-name) name="${args[$((i + 1))]:-}" ;;
    --job-name=*) name="${args[$i]#--job-name=}" ;;
  esac
done
if [ -z "$name" ]; then
  # mkdir is atomic: two runs started in the same second do not get the same name (the lock sits outside jobs/,
  # where the viewer would list it as a run)
  lock="${TMPDIR:-/tmp}/run_with_judge.$task"
  while name=$(date +%Y-%m-%d__%H-%M-%S); [ -e "$jobs/$name" ] || ! mkdir "$lock.$name" 2>/dev/null; do sleep 1; done
  name_lock="$lock.$name"  # removed by cleanup on exit
  args+=(--job-name "$name")
fi

status=0
harbor run -p "$REPO/tasks/$task" -o "$jobs" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} "${args[@]}" || status=$?
job="$jobs/$name"
if [ ! -d "$job" ]; then
  echo "no run folder $job" >&2
  exit $(( status ? status : 1 ))
fi
if [ "${SKIP_JUDGE:-}" = 1 ]; then
  echo "== SKIP_JUDGE=1: judge later with: bash scripts/run_with_judge.sh --judge-only $job"
elif [ "$status" = 0 ]; then
  judge_in_slot "$job" || status=$?
else
  judge_in_slot "$job" || true  # Harbor failed: judge what finished, keep Harbor's exit code
fi
exit "$status"
