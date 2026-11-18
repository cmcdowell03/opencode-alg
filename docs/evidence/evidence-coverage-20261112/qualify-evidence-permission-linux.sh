#!/usr/bin/env bash
set -uo pipefail
export PATH=/home/algtest/tools/bin:/home/algtest/tools/node-v22.23.4-linux-x64/bin:/usr/bin:/bin
export OPENCODE_BIN=/home/algtest/tools/opencode/node_modules/opencode-ai/bin/opencode.exe
export OPENCODE_ALG_LIVE_EVIDENCE=/tmp/opencode-alg-verification-evidence
commit="$1"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
source_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/opencode-alg-v1
evidence_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/implementation-evidence
native_root="/home/algtest/alg-evidence-permission-${commit:0:12}"
mkdir "$native_root" || exit 2
git -c safe.directory="$source_root" -C "$source_root" archive --format=tar "$commit" | tar -xf - -C "$native_root" || exit 2
ln -s /home/algtest/alg-v1-dependencies/node_modules "$native_root/node_modules"
cd "$native_root" || exit 2
bun run check > "$evidence_root/evidence-coverage-linux-full-corrected.log" 2>&1
type_status=$?
test_status=$type_status
live_status=$type_status
python3 - <<'PY'
import hashlib,json,pathlib,shutil
b=pathlib.Path('/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/implementation-evidence')
rows=[]
for s in (b/'evidence-coverage-linux-full-corrected.log').read_text().splitlines():
    if s.startswith('{'):
        try: rows.append(json.loads(s))
        except ValueError: pass
r=next(r for r in rows if r.get('check')=='opencode-alg-live')
p=pathlib.Path(r['evidence_path']); d=p.read_bytes()
assert hashlib.sha256(d).hexdigest()==r['evidence_sha256']
shutil.copyfile(p,b/'evidence-coverage-linux-live-corrected.json')
PY
receipt_status=$?
bun scripts/test-v1-headless.ts --output "$evidence_root/evidence-coverage-linux-headless-corrected.json" > "$evidence_root/evidence-coverage-linux-headless-corrected.log" 2>&1
headless_status=$?
bun "$evidence_root/request-source-identity.ts" "$native_root" > "$evidence_root/evidence-coverage-linux-identity.json"
identity_status=$?
printf 'Typecheck %s; targeted tests %s; registration %s; receipt copy %s; headless %s; identity %s\n' "$type_status" "$test_status" "$live_status" "$receipt_status" "$headless_status" "$identity_status"
tail -5 "$evidence_root/evidence-coverage-linux-full-corrected.log"
tail -1 "$evidence_root/evidence-coverage-linux-headless-corrected.log"
test "$type_status" -eq 0 && test "$test_status" -eq 0 && test "$live_status" -eq 0 && test "$receipt_status" -eq 0 && test "$headless_status" -eq 0 && test "$identity_status" -eq 0
