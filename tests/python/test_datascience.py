from __future__ import annotations
import json
import os
import sys
import tempfile
import unittest
import subprocess
import shutil
import copy
from unittest import mock
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
try:
    import duckdb
    import pyarrow
except ImportError:
    PREPARED = False
else:
    PREPARED = True
    from capabilities.datascience.operations import direct_path, run_operation
    from capabilities.datascience.operations import canonical, digest
    from capabilities.datascience.catalog import rebuild_catalog, source_canonical, project_identity
    from capabilities.datascience import operations, catalog, runner

@unittest.skipUnless(PREPARED, "prepared Data Science environment with DuckDB and PyArrow is required")
class DataScienceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="alg-ds-test-")
        self.project = self.temp.name
        self.source = Path(self.project, "fixture.csv")
        self.source.write_text("id,value,email\n1,10,a@example.invalid\n2,20,b@example.invalid\n3,,c@example.invalid\n", encoding="utf8")
        self.request = {"operation": "preview", "source": "fixture.csv", "exclude_columns": ["email"]}
    def tearDown(self):
        self.temp.cleanup()
    def test_profile_exclusion_and_source_identity(self):
        result = run_operation(self.project, self.request)
        self.assertEqual(result["rows"], 3)
        self.assertEqual(result["columns"][1]["mean"], 15)
        self.assertEqual(result["columns"][1]["nulls"], 1)
        self.assertNotIn("email", json.dumps(result))
        self.assertNotIn("example.invalid", json.dumps(result))
        self.assertFalse(Path(self.project, ".opencode").exists())
    def test_quality_and_filter(self):
        result = run_operation(self.project, {**self.request, "operation": "validate", "checks": [{"column": "value", "kind": "not_null"}]})
        self.assertFalse(result["ok"])
        result = run_operation(self.project, {**self.request, "filter": {"column": "id", "equals": 2}})
        self.assertEqual(result["rows"], 1)
        self.assertEqual(result["columns"][1]["mean"], 20)
        with self.assertRaises(ValueError):
            run_operation(self.project, {**self.request, "filter": {"column": "email", "equals": "a@example.invalid"}})
    def test_staged_export_exact_hash_and_roundtrip(self):
        preview = run_operation(self.project, self.request)
        export = {**self.request, "operation": "export", "confirm": True, "expected_source_sha256": preview["source_sha256"]}
        result = run_operation(self.project, export)
        self.assertEqual(result, run_operation(self.project, export))
        roundtrip = run_operation(self.project, {"operation": "profile", "source": result["artifact"]["path"], "exclude_columns": []})
        self.assertEqual(roundtrip["columns"], result["columns"])
        with self.assertRaises(ValueError):
            run_operation(self.project, {**export, "expected_source_sha256": "a" * 64})
        with self.assertRaises(ValueError):
            run_operation(self.project, {**export, "checks": [{"column": "value", "kind": "not_null"}]})
    def test_denied_paths_and_unknown_operations(self):
        for path in ["../outside.csv", "/etc/passwd", "C:/Windows/system.ini", "file:thing.csv"]:
            with self.assertRaises(ValueError):
                direct_path(self.project, path)
        with self.assertRaises(ValueError):
            run_operation(self.project, {**self.request, "sql": "COPY secret"})
        with self.assertRaises(ValueError):
            run_operation(self.project, {**self.request, "operation": "python"})
    def test_catalog_logical_rebuild_and_scope(self):
        project_hash = project_identity(self.project)
        record = {"schema_version": 1, "project": project_hash, "privacy": "project-private", "kind": "outcome", "status": "success", "group": "task-1", "skill_version": None, "observed_at": "2026-09-04T00:00:00Z", "source": {"type": "test", "id": "synthetic", "sha256": "b" * 64}, "summary": "synthetic outcome", "retention": "operational", "relations": [], "metrics": {"count": 1}}
        record["id"] = digest(source_canonical(record))
        snapshot = {"schema_version": 1, "project": project_hash, "source_count": 1, "logical_sha256": digest(source_canonical([record])), "records": [record]}
        first = rebuild_catalog(self.project, snapshot)
        second = rebuild_catalog(self.project, snapshot)
        self.assertEqual(first["logical_rows_sha256"], second["logical_rows_sha256"])
        self.assertFalse(first["authoritative"])
        with self.assertRaises(ValueError):
            rebuild_catalog(self.project, {**snapshot, "project": "f" * 64})
        with self.assertRaises(ValueError):
            rebuild_catalog(self.project, {**snapshot, "source_count": 2, "records": [record, record]})
        for key, bad in (("source_count", True), ("schema_version", True), ("logical_sha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                rebuild_catalog(self.project, {**snapshot, key: bad})
        malformed = copy.deepcopy(snapshot)
        del malformed["records"][0]["metrics"]
        malformed["logical_sha256"] = digest(source_canonical(malformed["records"]))
        with self.assertRaises(ValueError):
            rebuild_catalog(self.project, malformed)
        lock = Path(self.project, ".opencode/experience/catalog-staging/writer.lock")
        lock.write_text("foreign lock")
        with self.assertRaises(ValueError):
            rebuild_catalog(self.project, snapshot)
        self.assertEqual(lock.read_text(), "foreign lock")
        lock.unlink()
        original = catalog.publish
        def replace_lock(*args):
            lock.unlink()
            lock.write_text("replacement owner")
            return original(*args)
        with mock.patch.object(catalog, "publish", side_effect=replace_lock):
            rebuild_catalog(self.project, snapshot)
        self.assertEqual(lock.read_text(), "replacement owner")

    def test_invalid_types_and_pins_fail_before_dataset_read(self):
        for update in ({"operation": []}, {"source": 3}, {"exclude_columns": [[]]}, {"confirm": 1}, {"filter": {"column": [], "equals": 1}}, {"checks": [{"column": "id", "kind": []}]}, {"filter": {"column": "id", "equals": float("nan")}}):
            with self.subTest(update=update), mock.patch.object(operations, "read_table") as read:
                with self.assertRaises(ValueError):
                    run_operation(self.project, {**self.request, **update})
                read.assert_not_called()
        with mock.patch.object(operations.pa, "__version__", "0.0.0"), self.assertRaises(ValueError):
            run_operation(self.project, self.request)

    def test_portable_paths_and_immutable_no_overwrite(self):
        for name in ("NUL.csv", "fixture.csv.", "fixture.csv ", "a//b", "a/./b", "a\\b", "a\x00b", "a:stream"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                direct_path(self.project, name, exists=False)
        raw = b"synthetic artifact"
        artifact = operations.publish(self.project, raw, "json")
        path = Path(self.project, artifact["path"])
        path.write_bytes(b"foreign content")
        with self.assertRaises(ValueError):
            operations.publish(self.project, raw, "json")
        self.assertEqual(path.read_bytes(), b"foreign content")

    def test_real_cli_and_sanitized_invalid_json(self):
        command = [sys.executable, "-I", "-B", str(Path(runner.__file__)), "--worker", "--project", self.project]
        result = subprocess.run(command, input=runner.encode(self.request), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        parsed = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, parsed)
        self.assertTrue(all(parsed["cleanup"].values()))
        self.assertNotIn("example.invalid", result.stdout.decode())
        for raw in (b'{"operation":"preview","operation":"export"}', b'{"private":"CANARY_PRIVATE",', b'{"filter":NaN}'):
            result = subprocess.run(command, input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)["ok"])
            self.assertNotIn(b"CANARY_PRIVATE", result.stdout + result.stderr)

    def test_real_timeout_overflow_and_cleanup(self):
        result = runner.supervise(self.project, runner.encode(self.request), timeout=0.001)
        self.assertTrue(result["timed_out"], result)
        self.assertTrue(all(result["cleanup"].values()))
        original = subprocess.Popen
        def flood(args, **kwargs):
            return original([sys.executable, "-I", "-B", "-c", "import sys,time; sys.stdin.buffer.read(); sys.stdout.buffer.write(b'x'*200000); sys.stdout.buffer.flush(); time.sleep(30)"], **kwargs)
        with mock.patch.object(runner.subprocess, "Popen", side_effect=flood):
            result = runner.supervise(self.project, b"{}")
        self.assertIn("output exceeds", result["error"])
        self.assertTrue(all(result["cleanup"].values()))

    def test_real_typescript_catalog_bridge(self):
        root = Path(__file__).resolve().parents[2]
        script = """import {appendExperience,experienceCatalog} from './src/experience.ts';
const project=process.env.ALG_DS_FIXTURE_PROJECT;
appendExperience(project,{kind:'outcome',source:{type:'test',id:'bridge',sha256:'b'.repeat(64)},observed_at:'2026-09-04T00:00:00Z',retention:'operational',status:'success',summary:'Synthetic bridge',skill_version:null,group:'bridge',relations:[],metrics:{'2':1,'10':2,small:1e-7,large:1e21,decimal:1.25}});
console.log(JSON.stringify(experienceCatalog(project)));"""
        environment = {**os.environ, "ALG_DS_FIXTURE_PROJECT": self.project}
        executable = Path(shutil.which("bun") or "bun")
        if executable.suffix.lower() in {".cmd", ".ps1"}:
            native = executable.parent / "node_modules/bun/bin/bun.exe"
            if native.is_file():
                executable = native
        bridge = subprocess.run([str(executable), "-e", script], cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(bridge.returncode, 0, bridge.stderr.decode())
        snapshot = json.loads(bridge.stdout)
        command = [sys.executable, "-I", "-B", str(Path(runner.__file__)), "--catalog-worker", "--project", self.project]
        result = subprocess.run(command, input=bridge.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        parsed = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, parsed)
        self.assertEqual(parsed["source_logical_sha256"], snapshot["logical_sha256"])
        self.assertNotEqual(parsed["logical_rows_sha256"], parsed["artifact"]["sha256"])
        with tempfile.TemporaryDirectory() as other, self.assertRaises(ValueError):
            rebuild_catalog(other, snapshot)

    def test_real_dataset_receipt_experience_bridge(self):
        preview = run_operation(self.project, self.request)
        exported = run_operation(self.project, {**self.request, "operation": "export", "confirm": True, "expected_source_sha256": preview["source_sha256"]})
        executable = Path(shutil.which("bun") or "bun")
        if executable.suffix.lower() == ".cmd":
            executable = executable.parent / "node_modules/bun/bin/bun.exe"
        root = Path(__file__).resolve().parents[2]
        script = "import {importDatasetExperience} from './src/experience.ts'; console.log(JSON.stringify(importDatasetExperience(" + json.dumps(self.project) + "," + json.dumps(exported["receipt"]["path"]) + ",'2026-09-04T00:00:00Z')));"
        result = subprocess.run([str(executable), "-e", script], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        record = json.loads(result.stdout)
        self.assertEqual(record["kind"], "dataset")
        self.assertEqual(record["metrics"]["rows"], 3)
        self.assertNotIn("email", result.stdout.decode())
        Path(self.project, exported["artifact"]["path"]).write_bytes(b"synthetic corruption")
        rejected = subprocess.run([str(executable), "-e", script], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("dataset artifact hash mismatch", rejected.stderr.decode())

if __name__ == "__main__":
    unittest.main()
