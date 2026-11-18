#!/bin/bash
set -euo pipefail
mkdir -p /logs/verifier
# Harbor moves these bind-mounted logs on the host before it returns ownership.
# Directories created as root must be writable by that user, including when
# this script stops early.
umask 000
release_logs() {
  chmod -R a+rwX /logs || true
}
trap release_logs EXIT
release_logs
chmod 700 /tests
chmod -R a+rwX /app/bot
# STAGE comes from [steps.verifier.env] in task.toml. stage0 uses /tests itself.
cases_dir=/tests
if [ "${STAGE:-stage0}" != "stage0" ]; then
  cases_dir="/tests/stages/${STAGE}"
fi
status=0
replay_args=()
if [ "${REPLAY:-1}" != "1" ]; then
  replay_args=(--no-replay)
fi
python3 /tests/verify.py run --cases "$cases_dir/cases.json" --seed /tests/seed --rules "$cases_dir/rules.json" \
  --workers "${VERIFIER_WORKERS:-$(nproc)}" "${replay_args[@]}" || status=$?
exit "$status"
