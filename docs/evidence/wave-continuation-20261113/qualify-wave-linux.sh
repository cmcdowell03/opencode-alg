#!/usr/bin/env bash
set -uo pipefail
export PATH=/home/algtest/tools/bin:/home/algtest/tools/node-v22.23.4-linux-x64/bin:/usr/bin:/bin
export OPENCODE_BIN=/home/algtest/tools/opencode/node_modules/opencode-ai/bin/opencode.exe
export OPENCODE_ALG_LIVE_EVIDENCE=/tmp/opencode-alg-verification-evidence
commit="$1"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
source_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/opencode-alg-v1
evidence_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/implementation-evidence
native_root="/home/algtest/alg-wave-${commit:0:12}-r2"
prefix="$evidence_root/wave-${commit:0:12}-linux"
mkdir "$native_root" || exit 2
git -c safe.directory="$source_root" -C "$source_root" archive --format=tar "$commit" | tar -xf - -C "$native_root" || exit 2
ln -s /home/algtest/alg-v1-dependencies/node_modules "$native_root/node_modules"
cd "$native_root" || exit 2
bun run typecheck > "$prefix-typecheck.log" 2>&1
typecheck_status=$?
bun test tests/wave-continuation.test.ts tests/executor.test.ts tests/task-recovery.test.ts tests/task-allowance-execution.test.ts tests/allowance-headless-probe.test.ts tests/build-benchmark-protocol.test.ts tests/build-benchmark-retention.test.ts tests/build-benchmark-retention-boundaries.test.ts tests/live-retention-runner.test.ts tests/hard-benchmark-fixtures.test.ts tests/hard-benchmark-cohort.test.ts tests/hard-benchmark-qualification.test.ts --timeout 60000 > "$prefix-tests.log" 2>&1
test_status=$?
bun scripts/test-v1-headless.ts --output "$prefix-headless.json" > "$prefix-headless.log" 2>&1
headless_status=$?
bun "$evidence_root/request-source-identity.ts" "$native_root" > "$prefix-identity.json"
identity_status=$?
python3 - "$prefix" "$commit" "$typecheck_status" "$test_status" "$headless_status" "$identity_status" <<'PY'
import json,pathlib,sys
keys=['typecheck','focused_tests','headless','identity']
result={'source_commit':sys.argv[2], 'exit_codes':dict(zip(keys,map(int,sys.argv[3:]))), 'full_suite':False}
result['passed']=all(v==0 for v in result['exit_codes'].values())
pathlib.Path(sys.argv[1]+'-gate.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
tail -5 "$prefix-tests.log"
tail -1 "$prefix-headless.log"
test "$typecheck_status" -eq 0 && test "$test_status" -eq 0 && test "$headless_status" -eq 0 && test "$identity_status" -eq 0
