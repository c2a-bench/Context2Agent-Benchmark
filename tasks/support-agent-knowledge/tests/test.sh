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
# Fixed S across all knowledge conditions: always the shared stage-0 suite.
cases_dir=/tests
status=0
python3 /tests/verify.py run --cases "$cases_dir/cases.json" --seed /tests/seed --rules "$cases_dir/rules.json" \
  --workers "${VERIFIER_WORKERS:-$(nproc)}" || status=$?
exit "$status"
