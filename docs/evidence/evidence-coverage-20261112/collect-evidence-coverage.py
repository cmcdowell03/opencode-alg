import hashlib, json, pathlib, re, shutil

base = pathlib.Path(__file__).resolve().parent
repo = base.parent / 'opencode-alg-v1'
dest = repo / 'docs' / 'evidence' / 'evidence-coverage-20261112'
code_commit = '9acacd78da4bb564ce503a7388926b7e1a21f042'

def read(name):
    return json.loads((base / name).read_text(encoding='utf-8-sig'))

def counts(name):
    text = (base / name).read_text(encoding='utf-8-sig')
    result = {}
    for key in ['pass','skip','fail']:
        matches = re.findall(r'^\s*(\d+) ' + key + r'\s*$', text, re.M)
        result[key] = int(matches[-1]) if matches else 0
    matches = re.findall(r'^\s*(\d+) expect\(\) calls', text, re.M)
    result['assertions'] = int(matches[-1]) if matches else None
    return result

win = read('evidence-coverage-windows-headless-9acacd7.json')
linux = read('evidence-coverage-linux-headless-corrected.json')
wl = read('evidence-coverage-windows-live-9acacd7.json')
ll = read('evidence-coverage-linux-live-corrected.json')
wi = read('evidence-coverage-windows-identity.json')
li = read('evidence-coverage-linux-identity.json')
for headless, live, identity in [(win,wl,wi),(linux,ll,li)]:
    assert headless['passed'] and live['passed']
    assert headless['source']['sha256'] == live['plugin_source']['sha256'] == identity['digest']
    assert live['plugin_source']['package_version'] == '0.5.9'
    assert live['temporary_environment_removed']
    assert not live['isolation']['user_global_config_modified']
    assert live['isolation']['global_config_snapshots']['unchanged']
    assert headless['host']['restarts'] == 2 and all(headless['host']['clean_exits'])
    assert all(headless['cleanup'].values())
    assert headless['isolation']['real_user_config_unchanged']
    assert not headless['isolation']['credentials_inherited']
    assert headless['task_contract']['digests_stable'] and headless['task_admission_probe']['passed']

windows_files = {r['path']:r for r in wi['files']}
linux_files = {r['path']:r for r in li['files']}
assert windows_files.keys() == linux_files.keys()
assert all(windows_files[p]['lf_sha256'] == linux_files[p]['lf_sha256'] for p in windows_files)
linux_tests = counts('evidence-coverage-linux-full-corrected.log')
assert linux_tests['fail'] == 0 and linux_tests['pass'] > 1300
assert counts('evidence-coverage-windows-final.log')['fail'] == 0

summary = {
  'runtime_commit':code_commit, 'base_commit':'032c8109f0832eacc984cf60197d64967f73fb82',
  'version':'0.5.9', 'scope':'V1 deterministic local qualification, not model-quality or superiority evidence',
  'windows_integration_at_base':counts('evidence-coverage-windows-final.log'),
  'windows_permission_followup':counts('evidence-coverage-permission-tests.log'),
  'windows_final_case_and_scope_delta':counts('evidence-coverage-final-delta.log'),
  'linux_full_check':linux_tests,
  'runtime_identity':{'windows':wi['digest'],'linux':li['digest'],'runtime_files':len(windows_files),
    'lf_normalized_equal':True,'raw_differing_files':sum(windows_files[p]['sha256'] != linux_files[p]['sha256'] for p in windows_files)},
  'headless':{label:{'version':r['host']['version'],'restarts':r['host']['restarts'],'compaction_recovered':r['task_contract']['persisted_after_compaction'],
    'contract_digests_stable':r['task_contract']['digests_stable'],'cleanup':r['cleanup'],'permissions_checked':r['task_admission_probe']['host_permissions_checked']}
    for label,r in [('windows',win),('linux',linux)]},
  'limitations':[
    'Windows final qualification uses the 351-test integration matrix at the base plus focused final-delta tests; no full Windows suite rerun.',
    'Headless contract probe plans a read-only investigation: it does not execute a scoped file mutation through a real model. Baseline/scope mutation and reconstruction are deterministic executor tests.',
    'Headless provider and datalake are local synthetic services. One requested compaction and two restarts are not a long-session information-loss estimate.',
    'Declared coverage is not semantic adequacy; external/global configuration, prior root-agent edits and concurrent/transient changes remain outside proof.',
    'The new candidate has no paid Build comparison. Earlier losses remain unchanged.',
  ],
}
dest.mkdir(parents=True,exist_ok=True)
files = sorted([p for p in base.glob('evidence-coverage-*') if p.suffix in {'.json','.log'}])
for p in files:
    assert p.stat().st_size < 5*1024*1024
    shutil.copyfile(p,dest/p.name)
for name in ['qualify-evidence-coverage-linux.sh','qualify-evidence-permission-linux.sh','request-source-identity.ts','collect-evidence-coverage.py']:
    shutil.copyfile(base/name,dest/name)
(dest/'summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
manifest = []
for p in sorted(dest.iterdir()):
    if p.name in {'manifest.json','README.md'}: continue
    data=p.read_bytes()
    manifest.append({'path':p.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(dest/'manifest.json').write_text(json.dumps({'runtime_commit':code_commit,'files':manifest},indent=2)+'\n',encoding='utf-8')
print(json.dumps(summary,indent=2))
