#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${HOME}/.config/opencode"
if [[ $# -gt 0 && "$1" != -* ]]; then
  CONFIG_DIR="$1"
  shift
fi

cd "$ROOT"
PACKAGE_MANAGER="${ALG_INSTALL_PACKAGE_MANAGER:-auto}"
case "$PACKAGE_MANAGER" in auto|bun|npm) ;; *) echo "ALG_INSTALL_PACKAGE_MANAGER must be auto, bun, or npm" >&2; exit 1 ;; esac
if [[ "$PACKAGE_MANAGER" == bun ]] || { [[ "$PACKAGE_MANAGER" == auto ]] && command -v bun >/dev/null 2>&1; }; then
  command -v bun >/dev/null 2>&1 || { echo "Selected package manager bun is unavailable" >&2; exit 1; }
  [[ -f "$ROOT/bun.lock" ]] || { echo "bun.lock is required for frozen dependency installation" >&2; exit 1; }
  bun install --frozen-lockfile --ignore-scripts || { echo "Frozen Bun install failed; configuration was not changed. Retry explicitly with ALG_INSTALL_PACKAGE_MANAGER=npm to use the npm lockfile." >&2; exit 1; }
  exec bun run scripts/installer-core.ts --config-dir "$CONFIG_DIR" "$@"
fi
if command -v npm >/dev/null 2>&1; then
  [[ -f "$ROOT/package-lock.json" || -f "$ROOT/npm-shrinkwrap.json" ]] || { echo "package-lock.json or npm-shrinkwrap.json is required for npm ci" >&2; exit 1; }
  npm ci --ignore-scripts --no-audit --no-fund
  exec npx --no-install tsx scripts/installer-core.ts --config-dir "$CONFIG_DIR" "$@"
fi

echo "Install Bun or Node.js/npm before installing ALG" >&2
exit 1
