#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CLI="$ROOT/scripts/manager-cli.ts"

if command -v bun >/dev/null 2>&1; then
  exec bun run "$CLI" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node --disable-warning=ExperimentalWarning --experimental-strip-types "$CLI" "$@"
fi

echo "Install Bun or Node.js 22+ to run the ALG release manager" >&2
exit 1
