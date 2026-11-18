import hashlib, json, pathlib, re, shutil, sys

repo, evidence, commit = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
prefix = 'scope-runtime-' + commit[:12] + '-linux'
read = lambda name: json.loads((evidence / name).read_text(encoding='utf-8-sig'))
gate = read(prefix + '-gate.json')
assert gate['passed'] and gate['source_commit'] == commit
win_name = 'scope-runtime-4a9d5b1a4b9d-windows-headless.json'
win, linux = read(win_name), read(prefix + '-headless.json')
for receipt in [win, linux]:
    assert receipt['passed'] and receipt['task_allowance_probe']['passed']
    assert receipt['task_allowance_probe']['scope_regression']['passed']
    assert receipt['task_scope_violation_probe']['passed']
    assert receipt['task_scope_violation_probe']['additional_sdk_creates'] == 0
    assert receipt['task_scope_violation_probe']['additional_sdk_prompts'] == 0
    assert receipt['task_scope_violation_probe']['reserved_before'] == receipt['task_scope_violation_probe']['reserved_after']
    assert receipt['host']['restarts'] == 2 and receipt['session']['recovered_compaction_message']
    assert all(receipt['cleanup'].values()) and receipt['isolation']['real_user_config_unchanged']
wi = read('scope-runtime-73370efe5bd8-windows-identity.json')
li = read(prefix + '-identity.json')
assert wi['digest'] == win['source']['sha256'] and li['digest'] == linux['source']['sha256']
wm, lm = {f['path']: f['lf_sha256'] for f in wi['files']}, {f['path']: f['lf_sha256'] for f in li['files']}
assert wm == lm
assert read('scope-runtime-73370ef-windows-package-gate.json')['passed']
preflight = read('hard-scope-preflight/result.json')
assert len(preflight['results']) == 12 and all(r['status'] == 'preflight_passed' and r['cleanup'] and r['auth_copy_removed'] and r['source_unchanged'] for r in preflight['results'])
assert preflight['source_unchanged'] and preflight['global_configuration_unchanged']
log = (evidence / (prefix + '-full.log')).read_text()
counts = {key: int(re.findall(r'(?m)^\s*(\d+) ' + key + r'\s*$', log)[-1]) for key in ['pass', 'skip', 'fail']}
assert counts['fail'] == 0
assert 'scope_hooks_and_checker_passed' in (evidence / (prefix + '-headless.log')).read_text()
destination = repo / 'docs/evidence/scope-runtime-20261113'
assert not destination.exists(), 'Evidence destination already exists'
destination.mkdir(parents=True)
selected = sorted(set(
    [p.name for p in evidence.glob(prefix + '-*')] +
    [p.name for p in evidence.glob('scope-runtime-4a9d5b1a4b9d-*')] +
    [p.name for p in evidence.glob('scope-runtime-ccf61aa-windows-*')] +
    [p.name for p in evidence.glob('scope-runtime-73370ef-windows-*')] +
    ['scope-runtime-73370efe5bd8-windows-identity.json', 'scope-runtime-windows-lock-repair.log',
     'hard-scope-c17-qualification.json', 'hard-scope-c17-qualification.log',
     'hard-scope-preflight/result.json', 'hard-scope-preflight/plan.json',
     'qualify-scope-runtime-linux.sh', 'collect-scope-runtime-evidence.py']
))
rows = []
for name in selected:
    src = evidence / name
    target = destination / name.replace('/', '--')
    data = src.read_bytes()
    target.write_bytes(data)
    assert data == target.read_bytes()
    rows.append({'file': target.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
summary = {'source_commit': commit, 'linux_full_check': counts,
           'runtime_files_normalized_equal': len(wm), 'windows_source_sha256': wi['digest'],
           'linux_source_sha256': li['digest'], 'windows_host': win['host']['version'],
           'linux_host': linux['host']['version'], 'actual_scope_hooks_and_negative_drift': True,
           'compactions_per_host': 1, 'restarts_per_host': 2, 'preflight_arms_passed': 12,
           'cleanup_and_global_config_checks': True,
           'limitations': ['Synthetic provider verifies mechanics, not model quality or information-loss rates.',
             'Initial ccf61aa Windows and 4a9d5b1 Linux gates failed and are preserved; not counted as passes.',
             'Windows host runtime is identical to final candidate; package fixes affect installer/metadata only.',
             'Windows focused checks overlap and are not a full Windows suite.',
             'No new offline transfer bundle, native natural-compaction soak or remote datalake acceptance.',
             'All 17 compatibility versions retained, bounded at 64; old readers cannot load v2 scope baselines.']}
(destination / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
data = (destination / 'summary.json').read_bytes()
rows.append({'file': 'summary.json', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
(destination / 'manifest.json').write_text(json.dumps(rows, indent=2) + '\n')
print(json.dumps({'files': len(rows), **summary}))
