import hashlib, json, pathlib, re, sys

root = pathlib.Path(__file__).parent
dest = pathlib.Path(sys.argv[1]) / "docs/evidence/wave-continuation-20261113"
# A partial collection can resume only when every pre-existing payload is exact.
read = lambda name: json.loads((root / name).read_text(encoding="utf-8-sig"))
windows = read("wave-5500ad6-windows-headless.json")
linux = read("wave-5500ad6afad5-linux-headless.json")
gate = read("wave-5500ad6afad5-linux-gate.json")
assert gate["passed"] and not gate["full_suite"]
for receipt in [windows, linux]:
    assert receipt["passed"] and all(receipt["cleanup"].values())
    assert receipt["isolation"]["real_user_config_unchanged"] and not receipt["isolation"]["credentials_inherited"]
    probe = receipt["task_allowance_probe"]
    assert probe["passed"] and probe["scope_regression"]["passed"]
    assert probe["wave_pause"] == {"phase": "wave-limit", "guidance_verified": True, "attempts": 1}
    assert [probe[k] for k in ["reserved_before_compaction", "reserved_after_restarts", "reserved_after_checker", "additional_dispatches_after_exhaustion"]] == [1,1,2,0]
    assert receipt["task_scope_violation_probe"]["passed"]
wi = read("wave-5500ad6-windows-identity.json")
li = read("wave-5500ad6afad5-linux-identity.json")
assert wi["digest"] == windows["source"]["sha256"] and li["digest"] == linux["source"]["sha256"]
assert {r["path"]: r["lf_sha256"] for r in wi["files"]} == {r["path"]: r["lf_sha256"] for r in li["files"]}
qualification = read("repair-hard-qualification-v2.json")
assert qualification["schema"] == "alg-hard-development-qualification-v2"
assert qualification["development"]["passed"] and qualification["development"]["caseCount"] == 24
assert qualification["public_http"]["passed"] and qualification["public_http"]["caseCount"] == 8
files = [
    "repair-windows-measurement.log", "repair-windows-wave.log", "repair-windows-final-focused.log",
    "repair-final-typecheck.log", "repair-final-typecheck-2.log", "repair-hard-qualification-v2.json",
    "wave-5500ad6-windows-headless.json", "wave-5500ad6-windows-headless.log",
    "wave-5500ad6-windows-identity.json", "wave-5500ad6-windows-package.log",
    "wave-5500ad6afad5-linux-typecheck.log", "wave-5500ad6afad5-linux-tests.log",
    "wave-5500ad6afad5-linux-headless.json", "wave-5500ad6afad5-linux-headless.log",
    "wave-5500ad6afad5-linux-identity.json", "wave-5500ad6afad5-linux-gate.json",
    "wave-5500ad6-linux-setup-failure.json", "qualify-wave-linux.sh", "collect-wave-evidence.py",
]
dest.mkdir(parents=True, exist_ok=True)
assert not (dest / "manifest.json").exists(), "preserve a finalized collection"
manifest = []
for name in files:
    data = (root / name).read_bytes()
    if name.endswith((".json", ".log")):
        assert not re.search(rb"(?:(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9_.-]{20,}|-----BEGIN .*PRIVATE KEY-----)", data), "credential-shaped evidence"
    target = dest / name
    if target.exists():
        assert target.read_bytes() == data, "existing evidence differs"
    else:
        target.write_bytes(data)
    manifest.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
(dest / "manifest.json").write_text(json.dumps({
    "source_commit": "5500ad6afad56b5ccc3bfdd0b90c568b3413a56d",
    "runtime_files_lf_equal": len(wi["files"]), "files": manifest,
    "failed_checks_preserved": ["repair-windows-wave.log", "repair-final-typecheck.log", "wave-5500ad6-linux-setup-failure.json"],
    "initial_measurement_checks": ["repair-windows-measurement.log"],
    "collection_note": "The initial substring scan matched the sk- suffix inside a synthetic task- run ID; the second matched the scanner's own literal sentinel. Receipt/log scans now require a token boundary; the two authored helper source files were reviewed as code. Existing partial payloads were compared byte-for-byte before collection resumed. No test or model was rerun for this archive repair.",
    "interpretation": "Final focused/local host qualification, not a new full suite or paid behavior comparison."
}, indent=2) + "\n")
print(json.dumps({"files": len(files), "runtime_files_lf_equal": len(wi["files"]), "target": str(dest)}))
