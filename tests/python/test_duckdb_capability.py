from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import threading
import asyncio
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

try:
    import duckdb  # type: ignore
    import sqlglot  # type: ignore  # noqa: F401
except ImportError:
    duckdb = None

if duckdb is not None:
    from capabilities.duckdb import contract, fastapi_adapter, policy, query_plane


@unittest.skipUnless(duckdb is not None, "prepared DuckDB capability environment is required")
class DuckDBCapabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="alg-duckdb-tests-")
        self.base = Path(self.temporary.name)
        self.replica = self.base / "reviewed-replica.duckdb"
        connection = duckdb.connect(str(self.replica))
        connection.execute("CREATE TABLE events(event_date DATE, value VARCHAR, email VARCHAR)")
        connection.execute(
            "INSERT INTO events VALUES (DATE '2026-09-01', 'safe', 'person@example.invalid'), "
            "(DATE '2026-09-01', ?, 'second@example.invalid'), (DATE '2026-09-02', 'other', 'third@example.invalid')",
            [str(self.replica)],
        )
        connection.close()
        self.environment = {"ALG_DUCKDB_REPO_REPLICA": str(self.replica.resolve())}
        self.payload = {
            "capability_version": "0.1.0",
            "engine_version": "1.4.0",
            "parser_version": "27.14.0",
            "extensions": [],
            "settings": {"memory_limit": "128MB", "threads": 1, "max_temp_directory_size": "64MB"},
            "attachments": [{
                "alias": "repo", "source_env": "ALG_DUCKDB_REPO_REPLICA", "format": "duckdb", "read_only": True,
            }],
            "policy": {
                "allowed_relations": ["repo.main.events"],
                "protected_relations": {"repo.main.events": ["event_date"]},
                "sensitive_columns": ["email", "token"],
                "max_sql_characters": 20_000,
                "max_rows": 1,
                "max_characters": 16_384,
                "max_diagnostic_characters": 512,
                "timeout_ms": 5_000,
            },
        }
        self.contract_path = self.base / "contract.json"
        self.write_contract()
        self.previous = os.environ.get("ALG_DUCKDB_REPO_REPLICA")
        os.environ.update(self.environment)

    def tearDown(self) -> None:
        if self.previous is None:
            os.environ.pop("ALG_DUCKDB_REPO_REPLICA", None)
        else:
            os.environ["ALG_DUCKDB_REPO_REPLICA"] = self.previous
        self.temporary.cleanup()

    def write_contract(self) -> str:
        digest = contract.contract_hash(self.payload)
        envelope = {"schema_version": 1, "contract": self.payload, "contract_sha256": digest}
        self.contract_path.write_text(json.dumps(envelope, indent=2) + "\n", encoding="utf-8")
        return digest

    def test_contract_is_canonical_strict_and_environment_only(self) -> None:
        digest = self.write_contract()
        loaded = contract.load_contract(self.contract_path, digest, self.environment)
        self.assertEqual(loaded.sha256, digest)
        self.assertEqual(loaded.resolved_attachments[0].alias, "repo")
        self.assertEqual(loaded.resolved_attachments[0].path, self.replica.resolve())
        self.assertEqual(contract.contract_hash(self.payload), contract.contract_hash(copy.deepcopy(self.payload)))

        bad = copy.deepcopy(self.payload)
        bad["password"] = "do-not-store-this"
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(bad, self.environment)
        bad = copy.deepcopy(self.payload)
        bad["extensions"] = [{"name": "httpfs"}]
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(bad, self.environment)
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(self.payload, {"ALG_DUCKDB_REPO_REPLICA": "https://example.invalid/db"})
        with self.assertRaises(contract.ContractError):
            contract.load_contract(self.contract_path, "0" * 64, self.environment)

        duplicate = b'{"schema_version":1,"schema_version":1,"contract":{},"contract_sha256":"' + b"0" * 64 + b'"}'
        duplicate_path = self.base / "duplicate.json"
        duplicate_path.write_bytes(duplicate)
        with self.assertRaises(contract.ContractError):
            contract.load_contract(duplicate_path, "0" * 64, {})

    def test_parser_allows_scoped_selects_and_classifies_explain(self) -> None:
        accepted = [
            "SELECT count(*) FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01'",
            "WITH x AS (SELECT e.value FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01') SELECT count(*) FROM x",
            "SELECT count(*) FROM repo.main.events AS e JOIN repo.main.events AS f ON e.event_date = DATE '2026-09-01' AND f.event_date = DATE '2026-09-01'",
            "SELECT * FROM repo.main.events AS e WHERE (e.event_date = DATE '2026-09-01' AND e.value = 'a') OR e.event_date = DATE '2026-09-02'",
        ]
        for sql in accepted:
            with self.subTest(sql=sql):
                self.assertEqual(policy.validate_sql(sql, self.payload["policy"]).statement_class, "select")
        plain = policy.validate_sql(
            "EXPLAIN SELECT * FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01'", self.payload["policy"]
        )
        analyzed = policy.validate_sql(
            "EXPLAIN ANALYZE SELECT * FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01'",
            self.payload["policy"],
        )
        self.assertEqual((plain.statement_class, plain.executing), ("explain_select", False))
        self.assertEqual((analyzed.statement_class, analyzed.executing), ("explain_analyze_select", True))

    def test_adversarial_sql_fails_closed(self) -> None:
        rejected = [
            "SELECT 1; SELECT 2",
            "INSERT INTO repo.main.events VALUES (DATE '2026-09-01', 'x', 'x')",
            "EXPLAIN ANALYZE ATTACH 'x' AS bad",
            "SELECT * FROM read_parquet('fixture.parquet')",
            "SELECT query('SELECT 1')",
            "SELECT 'https://example.invalid/private'",
            "SELECT * FROM events AS e WHERE e.event_date = DATE '2026-09-01'",
            "SELECT * FROM repo.main.events AS e",
            "SELECT * FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01' OR e.value = 'bypass'",
            "SELECT * FROM repo.main.events AS e WHERE event_date = DATE '2026-09-01'",
            "SELECT * FROM repo.main.events AS e WHERE e.event_date = e.event_date",
            "SELECT * FROM repo.main.events AS e WHERE e.event_date IN (SELECT DATE '2026-09-01')",
            "WITH x AS (SELECT * FROM repo.main.events AS e) SELECT * FROM x WHERE event_date = DATE '2026-09-01'",
            "SELECT e.email AS harmless FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01'",
            "WITH RECURSIVE x AS (SELECT 1 UNION ALL SELECT 1 FROM x) SELECT * FROM x",
            "SELECT unknown_model_function(1)",
            "SHOW TABLES",
            "DESCRIBE repo.main.events",
            "PRAGMA version",
            "SET memory_limit='10GB'",
            "COPY (SELECT 1) TO 'out.csv'",
        ]
        for sql in rejected:
            with self.subTest(sql=sql):
                with self.assertRaises(policy.PolicyError):
                    policy.validate_sql(sql, self.payload["policy"])

    def test_disposable_execution_redacts_caps_and_reports_compatibility(self) -> None:
        digest = self.write_contract()
        sql = "SELECT * FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01' ORDER BY e.value"
        result = query_plane.query(str(self.contract_path), digest, sql)
        self.assertTrue(result["ok"], result)
        encoded = json.dumps(result)
        self.assertNotIn(str(self.replica), encoded)
        self.assertNotIn("person@example.invalid", encoded)
        self.assertIn("[redacted]", encoded)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["compatibility"]["engine_version"], "1.4.0")
        self.assertEqual(result["compatibility"]["parser_version"], "27.14.0")
        self.assertEqual(result["compatibility"]["extensions"], [])
        self.assertEqual(result["compatibility"]["attachment_aliases"], ["repo"])

        explained = query_plane.query(
            str(self.contract_path), digest,
            "EXPLAIN SELECT * FROM repo.main.events AS e WHERE e.event_date = DATE '2026-09-01'",
        )
        self.assertTrue(explained["ok"], explained)
        self.assertFalse(explained["executing"])

        adapter = fastapi_adapter.DuckDBQueryAdapter(str(self.contract_path), digest)
        self.assertTrue(adapter.compatibility()["ok"])
        self.assertTrue(adapter.execute("SELECT 1 AS safe")["ok"])

    def test_parent_timeout_path_invokes_process_tree_cancellation(self) -> None:
        digest = self.write_contract()
        loaded = contract.load_contract(self.contract_path, digest)

        loaded.contract["policy"]["timeout_ms"] = 1
        with mock.patch.object(query_plane, "_terminate_process_tree", wraps=query_plane._terminate_process_tree) as cancellation:
            result = query_plane._run_worker(loaded, "query", "SELECT 1")
        self.assertTrue(result["timed_out"])
        self.assertTrue(result["cancelled"])
        self.assertIsInstance(result["process_tree_cancelled"], bool)
        cancellation.assert_called_once()
        self.assertEqual(result["cleanup"], {"worker_exited": True, "temporary_removed": True})

    def test_engine_security_counterexamples_and_supported_queries(self) -> None:
        engine = duckdb.connect(str(self.replica))
        engine.execute("CREATE TABLE hidden(value VARCHAR)")
        engine.execute("INSERT INTO hidden VALUES ('safe')")
        engine.execute("CREATE VIEW disguised AS SELECT email AS innocuous FROM events")
        engine.close()
        rejected = [
            "SELECT e.value FROM repo.main.events e SEMI JOIN repo.main.hidden h ON e.value=h.value WHERE e.event_date=DATE '2026-09-01'",
            "SELECT e.value FROM repo.main.events e ANTI JOIN repo.main.hidden h ON e.value=h.value WHERE e.event_date=DATE '2026-09-01'",
            "WITH x(d,v,leaked) AS (SELECT * FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01') SELECT leaked FROM x",
            "SELECT e FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01'",
            "SELECT e.value FROM repo.main.events e LEFT JOIN repo.main.events f ON e.event_date=DATE '2026-09-01' AND f.event_date=DATE '2026-09-01'",
        ]
        engine = duckdb.connect()
        engine.execute("ATTACH '" + str(self.replica).replace("'", "''") + "' AS repo (READ_ONLY)")
        try:
            for sql in rejected:
                with self.subTest(sql=sql):
                    engine.execute(sql).fetchall()  # Actual engine-valid counterexample.
                    with self.assertRaises(policy.PolicyError):
                        query_plane.query(str(self.contract_path), self.write_contract(), sql)
        finally:
            engine.close()
        self.payload["policy"]["allowed_relations"].append("repo.main.disguised")
        result = query_plane.query(str(self.contract_path), self.write_contract(), "SELECT d.innocuous FROM repo.main.disguised d")
        self.assertFalse(result["ok"], result)
        self.assertNotIn("person@example.invalid", json.dumps(result))
        sql = "WITH x AS (SELECT e.value FROM repo.main.events e WHERE e.event_date=DATE '2026-09-01') SELECT x.value FROM x"
        self.assertTrue(query_plane.query(str(self.contract_path), self.write_contract(), sql)["ok"])

    def test_cleanup_failure_is_reported_and_response_bytes_are_bounded(self) -> None:
        digest = self.write_contract()
        with mock.patch.object(query_plane.shutil, "rmtree", side_effect=PermissionError("synthetic")):
            # Use a test-owned directory so fixture teardown cleans the injected failure.
            spill = self.base / "spill"
            spill.mkdir()
            with mock.patch.object(query_plane.tempfile, "mkdtemp", return_value=str(spill)):
                result = query_plane.query(str(self.contract_path), digest, "SELECT 1")
        self.assertFalse(result["ok"])
        self.assertFalse(result["cleanup"]["temporary_removed"])
        response = {"ok": True, "rows": [["😀" * 10000]], "cleanup": {"worker_exited": True, "temporary_removed": True}}
        bounded = query_plane.bound_response(response, self.payload["policy"])
        self.assertLessEqual(len(query_plane._encoded(bounded)), self.payload["policy"]["max_characters"])
        self.assertTrue(bounded["truncated"])

    def test_async_cancellation_waits_for_real_worker_cleanup(self) -> None:
        adapter = fastapi_adapter.DuckDBQueryAdapter(str(self.contract_path), self.write_contract())
        observed = []
        original = query_plane._supervise_worker
        def supervise(*args):
            result = original(*args)
            observed.append(result)
            return result
        async def run():
            task = asyncio.create_task(adapter.execute_async("SELECT 1"))
            await asyncio.sleep(0.03)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        with mock.patch.object(query_plane, "_supervise_worker", side_effect=supervise):
            asyncio.run(run())
        self.assertEqual(len(observed), 1)
        self.assertTrue(observed[0]["cancelled"])
        self.assertTrue(all(observed[0]["cleanup"].values()))

    def test_worker_environment_does_not_forward_ambient_credentials(self) -> None:
        digest = self.write_contract()
        loaded = contract.load_contract(self.contract_path, digest)
        previous = os.environ.get("UNRELATED_API_TOKEN")
        os.environ["UNRELATED_API_TOKEN"] = "must-not-cross-boundary"
        try:
            environment = query_plane._worker_environment(loaded, str(self.base))
        finally:
            if previous is None:
                os.environ.pop("UNRELATED_API_TOKEN", None)
            else:
                os.environ["UNRELATED_API_TOKEN"] = previous
        self.assertNotIn("UNRELATED_API_TOKEN", environment)
        self.assertEqual(environment["ALG_DUCKDB_REPO_REPLICA"], str(self.replica.resolve()))


if __name__ == "__main__":
    unittest.main()
