#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${HOME}/.config/opencode"
if [[ $# -gt 0 && "$1" != -* ]]; then
  CONFIG_DIR="$1"
  shift
fi

cd "$ROOT"
if command -v bun >/dev/null 2>&1; then
  bun install
  exec bun run scripts/installer-core.ts --config-dir "$CONFIG_DIR" "$@"
fi
if command -v npm >/dev/null 2>&1; then
  npm install
  exec npx --no-install tsx scripts/installer-core.ts --config-dir "$CONFIG_DIR" "$@"
fi

echo "Install Bun or Node.js/npm before installing ALG" >&2
exit 1
