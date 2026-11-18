#!/usr/bin/env bash
set -uo pipefail
export PATH=/home/algtest/tools/bin:/home/algtest/tools/node-v22.23.4-linux-x64/bin:/usr/bin:/bin
export OPENCODE_BIN=/home/algtest/tools/opencode/node_modules/opencode-ai/bin/opencode.exe
export OPENCODE_ALG_LIVE_EVIDENCE=/tmp/opencode-alg-verification-evidence
source_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/opencode-alg-v1
evidence_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/implementation-evidence
native_root=/home/algtest/alg-evidence-coverage-032c810
mkdir "$native_root" || exit 2
git -c safe.directory="$source_root" -C "$source_root" archive --format=tar 032c8109f0832eacc984cf60197d64967f73fb82 | tar -xf - -C "$native_root" || exit 2
ln -s /home/algtest/alg-v1-dependencies/node_modules "$native_root/node_modules"
cd "$native_root" || exit 2
bun run check > "$evidence_root/evidence-coverage-linux-check.log" 2>&1
check_status=$?
python3 - <<'PY'
import hashlib,json,pathlib,shutil
base=pathlib.Path('/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/implementation-evidence')
rows=[]
for line in (base/'evidence-coverage-linux-check.log').read_text().splitlines():
    if line.startswith('{'):
        try: rows.append(json.loads(line))
        except ValueError: pass
for row in rows:
    if row.get('check')=='opencode-alg-live':
        source=pathlib.Path(row['evidence_path'])
        data=source.read_bytes()
        assert hashlib.sha256(data).hexdigest()==row['evidence_sha256']
        shutil.copyfile(source,base/'evidence-coverage-linux-live.json')
PY
receipt_status=$?
bun scripts/test-v1-headless.ts --output "$evidence_root/evidence-coverage-linux-headless.json" > "$evidence_root/evidence-coverage-linux-headless.log" 2>&1
headless_status=$?
printf 'Full check exit: %s; receipt copy: %s; native headless: %s\n' "$check_status" "$receipt_status" "$headless_status"
tail -12 "$evidence_root/evidence-coverage-linux-check.log"
tail -3 "$evidence_root/evidence-coverage-linux-headless.log"
test "$check_status" -eq 0 && test "$receipt_status" -eq 0 && test "$headless_status" -eq 0
