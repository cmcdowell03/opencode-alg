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
  [[ -f "$ROOT/bun.lock" ]] || { echo "bun.lock is required for frozen dependency installation" >&2; exit 1; }
  bun install --frozen-lockfile --ignore-scripts
  exec bun run scripts/installer-core.ts --config-dir "$CONFIG_DIR" "$@"
fi
if command -v npm >/dev/null 2>&1; then
  [[ -f "$ROOT/package-lock.json" ]] || { echo "package-lock.json is required for npm ci" >&2; exit 1; }
  npm ci --ignore-scripts --no-audit --no-fund
  exec npx --no-install tsx scripts/installer-core.ts --config-dir "$CONFIG_DIR" "$@"
fi

echo "Install Bun or Node.js/npm before installing ALG" >&2
exit 1
