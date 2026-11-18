#!/bin/bash
# Install knowledge pack Rcomplete and wipe any prior bot so construction is fresh.
set -euo pipefail

rm -rf /app/bot
mkdir -p /app/bot
# Keep .gitkeep-style empty bot dir writable
chmod 777 /app/bot

if [ ! -d /app/pack/docs ]; then
  echo "missing /app/pack/docs for Rcomplete" >&2
  exit 1
fi

rm -rf /app/docs
cp -a /app/pack/docs /app/docs
rm -rf /app/pack
rm -f /app/setup.sh

# Record which condition was installed (for humans debugging the container).
echo "Rcomplete" > /app/docs/.knowledge_condition
