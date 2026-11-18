#!/usr/bin/env bash
set -uo pipefail
export PATH=/home/algtest/tools/bin:/home/algtest/tools/node-v22.23.4-linux-x64/bin:/usr/bin:/bin
export OPENCODE_BIN=/home/algtest/tools/opencode/node_modules/opencode-ai/bin/opencode.exe
export OPENCODE_ALG_LIVE_EVIDENCE=/tmp/opencode-alg-verification-evidence
commit="$1"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
source_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/opencode-alg-v1
evidence_root=/mnt/c/Users/codym/.codex/visualizations/2026/09/04/01a06ddf-9896-7883-8b6e-7c45c804afbf/implementation-evidence
native_root="/home/algtest/alg-task-allowance-${commit:0:12}"
prefix="$evidence_root/task-allowance-${commit:0:12}-linux"
mkdir "$native_root" || exit 2
git -c safe.directory="$source_root" -C "$source_root" archive --format=tar "$commit" | tar -xf - -C "$native_root" || exit 2
ln -s /home/algtest/alg-v1-dependencies/node_modules "$native_root/node_modules"
cd "$native_root" || exit 2
bun run check > "$prefix-full.log" 2>&1
full_status=$?
python3 - "$prefix" <<'PY'
import hashlib,json,pathlib,shutil,sys
prefix=sys.argv[1]
rows=[]
for s in pathlib.Path(prefix+'-full.log').read_text().splitlines():
    if s.startswith('{'):
        try: rows.append(json.loads(s))
        except ValueError: pass
r=next(r for r in rows if r.get('check')=='opencode-alg-live')
p=pathlib.Path(r['evidence_path']); d=p.read_bytes()
assert hashlib.sha256(d).hexdigest()==r['evidence_sha256']
shutil.copyfile(p,prefix+'-live.json')
PY
receipt_status=$?
bun scripts/test-v1-headless.ts --output "$prefix-headless.json" > "$prefix-headless.log" 2>&1
headless_status=$?
bun "$evidence_root/request-source-identity.ts" "$native_root" > "$prefix-identity.json"
identity_status=$?
python3 - "$prefix" "$commit" "$full_status" "$receipt_status" "$headless_status" "$identity_status" <<'PY'
import json,pathlib,sys
keys=['full_check','live_receipt_copy','headless','identity']
result={'source_commit':sys.argv[2], 'exit_codes':dict(zip(keys,map(int,sys.argv[3:])))}
result['passed']=all(v==0 for v in result['exit_codes'].values())
pathlib.Path(sys.argv[1]+'-gate.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
tail -5 "$prefix-full.log"
tail -1 "$prefix-headless.log"
test "$full_status" -eq 0 && test "$receipt_status" -eq 0 && test "$headless_status" -eq 0 && test "$identity_status" -eq 0
