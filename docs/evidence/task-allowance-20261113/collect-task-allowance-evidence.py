import hashlib, json, pathlib, re, shutil

base = pathlib.Path(__file__).resolve().parent
repo = base.parent / 'opencode-alg-v1'
dest = repo / 'docs/evidence/task-allowance-20261113'
commit = '5a2e8a604e0294d57f72ba21f85e0e77ddd395a7'
prefix = 'task-allowance-5a2e8a604e02-linux'

def read(name):
    return json.loads((base / name).read_text(encoding='utf-8-sig'))

def counts(name):
    text = (base / name).read_text(encoding='utf-8-sig')
    result = {}
    for key in ['pass', 'skip', 'fail']:
        values = re.findall(r'^\s*(\d+) ' + key + r'\s*$', text, re.M)
        result[key] = int(values[-1]) if values else 0
    values = re.findall(r'^\s*(\d+) expect\(\) calls', text, re.M)
    result['assertions'] = int(values[-1]) if values else None
    assert result['pass'] > 0 and result['assertions'] is not None
    return result

gate = read(prefix + '-gate.json')
assert gate['passed'] and gate['source_commit'] == commit
win = read('task-allowance-windows-headless-repaired.json')
lin = read(prefix + '-headless.json')
wl = read('task-allowance-windows-live.json')
ll = read(prefix + '-live.json')
wi = read('task-allowance-windows-identity.json')
li = read(prefix + '-identity.json')
for headless, live, identity in [(win, wl, wi), (lin, ll, li)]:
    assert headless['passed'] and live['passed']
    assert headless['source']['sha256'] == live['plugin_source']['sha256'] == identity['digest']
    assert live['plugin_source']['package_version'] == '0.5.10'
    assert live['temporary_environment_removed'] and not live['isolation']['user_global_config_modified']
    assert live['isolation']['global_config_snapshots']['unchanged']
    assert headless['host']['restarts'] == 2 and all(headless['host']['clean_exits'])
    assert all(headless['cleanup'].values()) and headless['isolation']['real_user_config_unchanged']
    assert not headless['isolation']['credentials_inherited']
    probe = headless['task_allowance_probe']
    assert probe['passed'] and probe['reserved_before_compaction'] == probe['reserved_after_restarts'] == 1
    assert probe['reserved_after_checker'] == 2 and probe['additional_dispatches_after_exhaustion'] == 0
    assert probe['checker_parent_verified']

wfiles = {row['path']: row for row in wi['files']}
lfiles = {row['path']: row for row in li['files']}
assert wfiles.keys() == lfiles.keys()
assert all(wfiles[path]['lf_sha256'] == lfiles[path]['lf_sha256'] for path in wfiles)
qualification = read('hard-development-qualification-d50ce31.json')
assert qualification['development']['passed'] and qualification['public_http']['passed']
preflight = read('hard-d50-preflight/result.json')
assert len(preflight['results']) == 12
assert all(row['status'] == 'preflight_passed' and row['cleanup'] and row['auth_copy_removed'] for row in preflight['results'])
assert preflight['source_unchanged'] and preflight['global_configuration_unchanged'] and preflight['fatal'] is None
logs = ['task-allowance-windows-reviewed.log', 'task-allowance-windows-lock-repair.log',
        'task-allowance-package-windows.log', 'task-allowance-runtime-fixture-repair.log',
        'hard-development-reviewed-tests.log', 'hard-development-longpath-corrected-tests.log', prefix + '-full.log']
test_results = {name: counts(name) for name in logs}
assert all(row['fail'] == 0 for row in test_results.values())
summary = {'version': '0.5.10', 'candidate_commit': commit,
           'runtime_implementation_commit': '2fa970dc3a70d77f7e05b21420b155f158b1bc86',
           'harness_path_repair_commit': 'd50ce31c67fbe785f6fbd477ccab73456cbf6bd0',
           'scope': 'Local deterministic qualification and no-generation preflight, not model-quality evidence',
           'tests_overlapping_do_not_sum': test_results, 'linux_gate': gate,
           'runtime_identity': {'windows': wi['digest'], 'linux': li['digest'], 'files': len(wfiles),
                                'lf_normalized_equal': True, 'raw_differing_files': sum(wfiles[p]['sha256'] != lfiles[p]['sha256'] for p in wfiles)},
           'headless': {name: {'host': row['host']['version'], 'restarts': row['host']['restarts'],
                              'allowance': row['task_allowance_probe'], 'cleanup': row['cleanup']}
                        for name, row in [('windows', win), ('linux', lin)]},
           'qualification': {key: {k: v for k, v in qualification[key].items() if k != 'results'} for key in ['development', 'public_http']},
           'preflight_arms': len(preflight['results']),
           'limitations': ['Full Windows suite was not repeated; changed-boundary and package suites are scoped and overlap.',
                           'Synthetic provider and local service; one requested compaction and two restarts are not a long-session loss-rate estimate.',
                           'Shared allowance counts ALG child reservations, not complete provider calls, root turns, compaction calls or invoice tokens.',
                           'Same-user hard-case execution is not OS-isolated or independent confirmation.',
                           'Earlier failed fixtures, stale qualification, long-path preflight and Linux gate remain failures.',
                           'No new offline transfer bundle or real datalake-mcp environment was accepted by these checks.']}
dest.mkdir(parents=True, exist_ok=True)
sources = set()
for pattern in ['task-allowance-*', 'hard-development-*', 'hard-d50-preflight.log']:
    sources.update(p for p in base.glob(pattern) if p.is_file() and p.suffix in {'.json', '.log'} and '-config' not in p.name)
for source in sorted(sources):
    assert source.stat().st_size < 5 * 1024 * 1024
    shutil.copyfile(source, dest / source.name)
for folder, label in [('hard-development-terra-20261113-preflight', 'preflight-longpath-failed'), ('hard-d50-preflight', 'preflight-final')]:
    for name in ['plan.json', 'result.json']:
        shutil.copyfile(base / folder / name, dest / (label + '-' + name))
for name in ['qualify-task-allowance-linux.sh', 'request-source-identity.ts', 'collect-task-allowance-evidence.py']:
    shutil.copyfile(base / name, dest / name)
(dest / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
manifest = []
for path in sorted(dest.iterdir()):
    if path.name in {'manifest.json', 'README.md'}: continue
    data = path.read_bytes()
    manifest.append({'path': path.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
(dest / 'manifest.json').write_text(json.dumps({'candidate_commit': commit, 'files': manifest}, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'files': len(manifest), 'runtime_files': len(wfiles), 'tests': test_results}, indent=2))
