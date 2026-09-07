"""Synthetic engine, stdio, and real-process security boundary regressions."""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

import test_duckdb_capability as fixtures

if fixtures.duckdb is not None:
    from capabilities.duckdb import contract, policy, query_plane


@unittest.skipUnless(fixtures.duckdb is not None, "prepared DuckDB environment required")
class PolicyExecutionTests(unittest.TestCase):
    setUp = fixtures.DuckDBCapabilityTests.setUp
    tearDown = fixtures.DuckDBCapabilityTests.tearDown
    write_contract = fixtures.DuckDBCapabilityTests.write_contract

    def test_join_matrix_inventory_and_scalar_cte(self):
        engine = fixtures.duckdb.connect(str(self.replica))
        engine.execute("CREATE TABLE hidden(value VARCHAR)")
        engine.execute("INSERT INTO hidden VALUES ('safe')")
        engine.close()
        for join in ("JOIN", "INNER JOIN", "CROSS JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "SEMI JOIN", "ANTI JOIN"):
            sql = f"SELECT e.value FROM repo.main.events e {join} repo.main.hidden h"
            if join != "CROSS JOIN":
                sql += " ON e.value=h.value"
            sql += " WHERE e.event_date=DATE '2026-09-01'"
            with self.subTest(join=join), self.assertRaises(policy.PolicyError):
                policy.validate_sql(sql, self.payload["policy"])
        self.payload["policy"]["allowed_relations"].append("repo.main.hidden")
        sql = "SELECT e.value FROM repo.main.events e JOIN repo.main.hidden h ON e.value=h.value WHERE e.event_date=DATE '2026-09-01'"
        result = query_plane.query(str(self.contract_path), self.write_contract(), sql)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["relations"], ["repo.main.events", "repo.main.hidden"])
        self.assertEqual(result["rows"], [["safe"]])

    def test_malformed_and_disguised_sensitive_expressions(self):
        sqls = [
            "SELECT (1", "SELECT 1 +", "SELECT FROM", "SELECT 1 WHERE",
            "SELECT e.email AS value FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01'",
            "SELECT lower(e.email) FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01'",
            "SELECT e['email'] FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01'",
            "SELECT * REPLACE (email AS value) FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01'",
            "SELECT * FROM repo.main.events e(d,v,leaked) WHERE e.d=DATE '2026-09-01'",
            "WITH x AS (SELECT * FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01') SELECT x.value FROM x",
            "SELECT min(e.*) FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01'",
        ]
        for sql in sqls:
            with self.subTest(sql=sql), self.assertRaises(policy.PolicyError):
                policy.validate_sql(sql, self.payload["policy"])

    def test_partition_selection_is_finite_and_derived_tables_work(self):
        for predicate in (
            "e.event_date >= DATE '1900-01-01'",
            "e.event_date BETWEEN DATE '1900-01-01' AND DATE '2999-01-01'",
            "e.event_date IN (" + ",".join(["DATE '2026-09-01'"] * 33) + ")",
        ):
            with self.subTest(predicate=predicate), self.assertRaises(policy.PolicyError):
                policy.validate_sql("SELECT e.value FROM repo.main.events e WHERE " + predicate, self.payload["policy"])
        sql = "SELECT x.value FROM (SELECT e.value FROM repo.main.events e WHERE e.event_date IN (DATE '2026-09-01')) x"
        result = query_plane.query(str(self.contract_path), self.write_contract(), sql)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["relations"], ["repo.main.events"])
        self.assertEqual(result["compatibility"]["extensions_kind"], "requested_contract_inventory")
        self.assertIsInstance(result["compatibility"]["loaded_extensions"], list)

    def test_structured_source_and_nonfinite_output(self):
        engine = fixtures.duckdb.connect(str(self.replica))
        engine.execute("CREATE TABLE nested AS SELECT {'email': 'CANARY_STRUCT'} AS innocuous")
        engine.close()
        self.payload["policy"]["allowed_relations"].append("repo.main.nested")
        digest = self.write_contract()
        result = query_plane.query(str(self.contract_path), digest, "SELECT n.innocuous FROM repo.main.nested n")
        self.assertFalse(result["ok"])
        self.assertNotIn("CANARY_STRUCT", json.dumps(result))
        result = query_plane.query(str(self.contract_path), digest, "SELECT CAST('NaN' AS DOUBLE)")
        self.assertTrue(result["ok"], result)
        json.dumps(result, allow_nan=False)

    def test_real_stdout_flood_is_stopped_at_bound(self):
        loaded = contract.load_contract(self.contract_path, self.write_contract())
        original = subprocess.Popen
        processes = []
        def start(args, **kwargs):
            if not str(args[-1]).endswith("worker.py"):
                return original(args, **kwargs)
            args = [sys.executable, "-I", "-c", "import sys,time; sys.stdin.buffer.read(); sys.stdout.buffer.write(b'x'*1000000); sys.stdout.buffer.flush(); time.sleep(30)"]
            process = original(args, **kwargs)
            processes.append(process)
            return process
        with mock.patch.object(query_plane.subprocess, "Popen", side_effect=start):
            result = query_plane._run_worker(loaded, "query", "SELECT 1")
        self.assertFalse(result["ok"])
        self.assertIn("byte cap", result["error"])
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(all(result["cleanup"].values()))

    def test_admission_is_bounded_without_launch(self):
        loaded = contract.load_contract(self.contract_path, self.write_contract())
        query_plane._ADMISSION.acquire()
        query_plane._ADMISSION.acquire()
        try:
            with mock.patch.object(query_plane.subprocess, "Popen") as start:
                result = query_plane._run_worker(loaded, "query", "SELECT 1")
            self.assertTrue(result["busy"])
            start.assert_not_called()
        finally:
            query_plane._ADMISSION.release()
            query_plane._ADMISSION.release()

    @unittest.skipUnless(os.name == "nt", "Windows Job lifetime regression")
    def test_abrupt_parent_exit_kills_owned_worker(self):
        import ctypes
        from ctypes import wintypes
        code = """
import subprocess, sys, time
from capabilities.duckdb.query_plane import _WindowsJob
child = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(60)'], stdout=subprocess.DEVNULL)
job = _WindowsJob(child)
print(child.pid, flush=True)
time.sleep(60)
"""
        parent = subprocess.Popen([sys.executable, "-B", "-c", code], cwd=fixtures.ROOT,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output = queue.Queue()
        reader = threading.Thread(target=lambda: output.put(parent.stdout.readline()), daemon=True)
        reader.start()
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = None
        try:
            child_pid = int(output.get(timeout=10))
            handle = api.OpenProcess(0x100001, False, child_pid)
            self.assertTrue(handle)
            parent.kill()
            parent.wait(timeout=5)
            self.assertEqual(api.WaitForSingleObject(handle, 5000), 0)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=5)
            if handle:
                if api.WaitForSingleObject(handle, 0) != 0:
                    api.TerminateProcess(handle, 1)
                    api.WaitForSingleObject(handle, 5000)
                api.CloseHandle(handle)
            reader.join(timeout=1)
            parent.stdout.close()
            parent.stderr.close()

    def test_mcp_query_name_cancellation_and_responsive_ping(self):
        digest = self.write_contract()
        process = subprocess.Popen(
            [sys.executable, "-B", str(fixtures.ROOT / "capabilities/duckdb/wrapper.py"),
             "--contract", str(self.contract_path), "--hash", digest, "--mcp"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        responses = queue.Queue()
        def read():
            for line in process.stdout:
                responses.put(json.loads(line))
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        def send(method, identifier=None, params=None):
            value = {"jsonrpc": "2.0", "method": method}
            if identifier is not None:
                value["id"] = identifier
            if params is not None:
                value["params"] = params
            process.stdin.write((json.dumps(value) + "\n").encode())
            process.stdin.flush()
        try:
            send("initialize", 1, {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "synthetic", "version": "1"}})
            self.assertEqual(responses.get(timeout=10)["id"], 1)
            send("notifications/initialized")
            send("tools/list", 2)
            self.assertEqual(responses.get(timeout=5)["result"]["tools"][0]["name"], "query")
            send("tools/call", 3, {"name": "query", "arguments": {"sql": "SELECT 1"}})
            send("notifications/cancelled", params={"requestId": 3})
            send("ping", 4)
            received = [responses.get(timeout=10), responses.get(timeout=10)]
            self.assertEqual({item["id"] for item in received}, {3, 4})
            result = json.loads(next(item for item in received if item["id"] == 3)["result"]["content"][0]["text"])
            self.assertTrue(result["cancelled"], result)
            self.assertTrue(all(result["cleanup"].values()))
            send("tools/call", 5, {"name": "query", "arguments": {"sql": "SELECT 1 AS safe"}})
            success = responses.get(timeout=10)
            self.assertFalse(success["result"]["isError"], success)
            process.stdin.close()
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            reader.join(timeout=2)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()


if __name__ == "__main__":
    unittest.main()
