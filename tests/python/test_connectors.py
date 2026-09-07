"""Only synthetic data and prepared local Python modules; no extension is loaded."""
from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

try:
    import duckdb
    import sqlglot
except ImportError:
    duckdb = None

if duckdb is not None:
    from capabilities.connectors import (ConnectorError, DeploymentRequired, activate_remote,
        contract_hash, load_json, materialize_synthetic, prepare)
    from capabilities.duckdb.policy import validate_sql


class FixtureConnection:
    """SQL-recording remote stand-in; data selection runs on real local DuckDB."""
    def __init__(self, plan, extra_rows=()):
        self.connection = duckdb.connect(":memory:", config={
            "autoinstall_known_extensions": "false", "autoload_known_extensions": "false"})
        self.connection.execute("ATTACH ':memory:' AS source")
        self.connection.execute("CREATE SCHEMA source.reviewed")
        self.connection.execute("CREATE TABLE source.reviewed.events(event_date DATE, value VARCHAR, private_email VARCHAR)")
        self.connection.executemany("INSERT INTO source.reviewed.events VALUES (?, ?, ?)", [
            (date(2026, 8, 31), "outside", "synthetic-private"),
            (date(2026, 9, 1), "selected", "synthetic-private"),
            (date(2026, 9, 2), "exclusive-end", "synthetic-private"), *extra_rows])
        self.plan = plan
        self.initialized_sql = []
        self.selection = None

    def initialize_preview(self, statements):
        # LOAD/SECRET/remote ATTACH are recorded, never submitted to DuckDB.
        self.initialized_sql.extend(statements)

    def execute_selection(self, sql, parameters):
        self.selection = (sql, parameters)
        self.assert_selection(sql)
        if self.plan.kind == "iceberg_s3":
            sql = sql.replace("iceberg_scan('s3://fixture-bucket/reviewed/events/metadata/v1.metadata.json', allow_moved_paths = false)",
                              'source."reviewed"."events"')
        return self.connection.execute(sql, parameters)

    def assert_selection(self, sql):
        if sql != self.plan.sql:
            raise AssertionError("selection changed")

    def close(self):
        self.connection.close()


@unittest.skipUnless(duckdb is not None, "prepared connector test environment with DuckDB and sqlglot is required")
class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="alg-connectors-synthetic-")
        self.base = Path(self.temp.name).resolve()
        with duckdb.connect(":memory:") as engine:
            self.platform = engine.execute("PRAGMA platform").fetchone()[0]
        self.environment = {"ALG_CONNECTOR_USER": "synthetic-user", "ALG_CONNECTOR_PASSWORD": "synthetic-private-password",
            "ALG_CONNECTOR_KEY": "synthetic-key", "ALG_CONNECTOR_SECRET": "synthetic-private-secret",
            "ALG_CONNECTOR_TOKEN": "synthetic-private-token"}

    def tearDown(self):
        self.temp.cleanup()

    def contract(self, kind="postgres"):
        extensions = []
        for name in (["postgres"] if kind == "postgres" else ["httpfs", "iceberg"]):
            path = self.base / (name + ".duckdb_extension")
            raw = ("synthetic bytes, NOT an extension binary: " + name).encode()
            path.write_bytes(raw)
            extensions.append({"name": name, "path": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                "engine_version": "1.4.0", "platform": self.platform})
        relation = {"id": "events", "source": "events", "columns": [
            {"name": "event_date", "type": "DATE"}, {"name": "value", "type": "VARCHAR"}],
            "date_column": "event_date", "available_start": "2026-01-01", "available_end": "2027-01-01"}
        endpoint = {"host": "replica.example.invalid", "port": 5432, "database": "analytics", "schema": "reviewed",
                    "sslmode": "verify-full", "connect_timeout_seconds": 5}
        refs = {"username_env": "ALG_CONNECTOR_USER", "password_env": "ALG_CONNECTOR_PASSWORD"}
        if kind == "iceberg_s3":
            endpoint = {"host": "s3.example.invalid", "port": 443, "region": "us-east-1", "bucket": "fixture-bucket",
                        "prefix": "reviewed/", "use_ssl": True, "url_style": "path"}
            refs = {"key_id_env": "ALG_CONNECTOR_KEY", "secret_env": "ALG_CONNECTOR_SECRET", "session_token_env": "ALG_CONNECTOR_TOKEN"}
            relation["source"] = "s3://fixture-bucket/reviewed/events/metadata/v1.metadata.json"
            relation["metadata_sha256"] = "a" * 64  # declared pin only; never claimed verified
        return {"schema_version": 1, "mode": "preparation_only", "kind": kind,
            "engine": {"name": "duckdb", "version": "1.4.0", "platform": self.platform},
            "extensions": extensions, "endpoint": endpoint, "credential_refs": refs, "relations": [relation],
            "limits": {"max_days": 7, "max_rows": 3, "max_bytes": 1024}}

    def prepare(self, c, **changes):
        arguments = dict(expected_sha256=contract_hash(c), runtime_version=duckdb.__version__, runtime_platform=self.platform,
            approved_endpoints=frozenset({"postgresql://replica.example.invalid:5432/analytics",
                "https://s3.example.invalid:443/fixture-bucket/reviewed/"}), environment=self.environment,
            relation_id="events", start="2026-09-01", end="2026-09-02")
        arguments.update(changes)
        return prepare(c, **arguments)

    def test_actual_runtime_identity(self):
        self.assertEqual(duckdb.__version__, "1.4.0")
        self.assertEqual(sqlglot.__version__, "27.14.0")

    def test_strict_version_hash_fields_and_json(self):
        c = self.contract()
        for mutate in [lambda x: x.update(schema_version=True), lambda x: x.update(schema_version=2),
                       lambda x: x.update(mode="active"), lambda x: x.update(password="synthetic-private-password"),
                       lambda x: x["limits"].update(max_days=True), lambda x: x["relations"][0].update(sql="SELECT *")]:
            invalid = copy.deepcopy(c); mutate(invalid)
            with self.assertRaises(ConnectorError): self.prepare(invalid)
        with self.assertRaises(ConnectorError): self.prepare(c, expected_sha256="0" * 64)
        for raw in [b'{"x":1,"x":2}', b'{"x":NaN}', b'[]', b' ' * (128 * 1024 + 1)]:
            with self.assertRaises(ConnectorError): load_json(raw)
        self.assertEqual(contract_hash(c), contract_hash(load_json(json.dumps(c).encode())))

    def test_endpoint_credentials_and_date_fail_closed(self):
        for kind in ["postgres", "iceberg_s3"]:
            c = self.contract(kind)
            for host in ["user:password@replica.example.invalid", "https://s3.example.invalid/a", "*.example.invalid",
                         "s3.example.invalid?secret=bad", "169.254.169.254", "replica.example.invalid\n"]:
                invalid = copy.deepcopy(c); invalid["endpoint"]["host"] = host
                with self.assertRaises(ConnectorError): self.prepare(invalid)
            with self.assertRaises(ConnectorError): self.prepare(c, approved_endpoints=frozenset())
            for env in [{}, {**self.environment, "ALG_CONNECTOR_PASSWORD": "", "ALG_CONNECTOR_SECRET": ""},
                        {**self.environment, "ALG_CONNECTOR_PASSWORD": "bad\nvalue", "ALG_CONNECTOR_SECRET": "bad\nvalue"}]:
                with self.assertRaises(ConnectorError): self.prepare(c, environment=env)
            invalid = copy.deepcopy(c)
            invalid["credential_refs"][next(iter(invalid["credential_refs"]))] = "inline-private-value"
            with self.assertRaises(ConnectorError): self.prepare(invalid)
            for start, end in [("2026-09-02", "2026-09-01"), ("2026-09-01", "2026-09-01"),
                               ("2026-09-01", "2026-09-09"), ("2026-02-30", "2026-03-01"),
                               ("20250901", "2026-09-02"), ("2025-12-31", "2026-01-02")]:
                with self.assertRaises(ConnectorError): self.prepare(c, start=start, end=end)
            self.assertEqual((self.prepare(c, end="2026-09-08").end - date(2026, 9, 1)).days, 7)

    def test_prepared_extension_hash_engine_and_platform_drift(self):
        c = self.contract()
        for changes in [{"runtime_version": "1.3.0"}, {"runtime_platform": "wrong_platform"}]:
            with self.assertRaises(ConnectorError): self.prepare(c, **changes)
        for key, value in [("name", "httpfs"), ("engine_version", "1.3.0"), ("platform", "wrong_platform"),
                           ("path", "postgres.duckdb_extension"), ("sha256", "0" * 64)]:
            invalid = copy.deepcopy(c); invalid["extensions"][0][key] = value
            with self.assertRaises(ConnectorError): self.prepare(invalid)
        Path(c["extensions"][0]["path"]).write_bytes(b"drift")
        with self.assertRaisesRegex(ConnectorError, "hash drift"): self.prepare(c)

    def test_curated_scope_and_metadata_paths(self):
        c = self.contract("iceberg_s3")
        for source in ["s3://other/reviewed/a.metadata.json", "s3://fixture-bucket/reviewed/../x.metadata.json",
                       "s3://fixture-bucket/reviewed/%2e%2e/x.metadata.json", "s3://fixture-bucket/reviewed/a*.metadata.json",
                       "s3://fixture-bucket/reviewed/a.metadata.json?token=bad", "s3://fixture-bucket/reviewed/a.parquet"]:
            invalid = copy.deepcopy(c); invalid["relations"][0]["source"] = source
            with self.assertRaises(ConnectorError): self.prepare(invalid)
        for mutate in [lambda x: x["relations"][0]["columns"].append({"name": "value", "type": "VARCHAR"}),
                       lambda x: x["relations"][0].update(date_column="private_email"),
                       lambda x: x["relations"][0]["columns"][1].update(type="STRUCT"),
                       lambda x: x["relations"].append(copy.deepcopy(x["relations"][0]))]:
            invalid = copy.deepcopy(c); mutate(invalid)
            with self.assertRaises(ConnectorError): self.prepare(invalid)
        with self.assertRaises(ConnectorError): self.prepare(c, relation_id="not_curated")

    def test_both_kinds_generate_preview_and_materialize_only_bounded_curated_data(self):
        for kind in ["postgres", "iceberg_s3"]:
            plan = self.prepare(self.contract(kind))
            sqlglot.parse_one(plan.sql, read="duckdb")
            source = FixtureConnection(plan)
            destination = self.base / (kind + ".duckdb")
            try:
                receipt = materialize_synthetic(plan, source, destination)
                self.assertEqual(receipt["rows"], 1)
                self.assertEqual(receipt["remote_pushdown"], "NOT_MEASURED")
                self.assertEqual(receipt["extension_abi"], "NOT_MEASURED")
                self.assertEqual(receipt["remote_metadata_hash"], "NOT_VERIFIED")
                self.assertFalse(receipt["remote_activated"])
                preview = "\n".join(source.initialized_sql)
                self.assertIn("SET autoinstall_known_extensions = false;", preview)
                self.assertIn("SET autoload_known_extensions = false;", preview)
                self.assertNotIn("INSTALL ", preview)
                self.assertNotIn("PERSISTENT", preview)
                self.assertIn("READ_ONLY" if kind == "postgres" else "USE_SSL true", preview)
                self.assertIn("${env:", preview)
                for private in self.environment.values():
                    self.assertNotIn(private, repr(plan) + json.dumps(receipt) + preview)
                with duckdb.connect(":memory:") as local:
                    local.execute("ATTACH '" + str(destination).replace("'", "''") + "' AS replica (READ_ONLY)")
                    query = "SELECT e.event_date, e.value FROM replica.main.events e WHERE e.event_date = DATE '2026-09-01'"
                    valid = validate_sql(query, {"max_sql_characters": 2000, "allowed_relations": ["replica.main.events"],
                        "protected_relations": {"replica.main.events": ["event_date"]}, "sensitive_columns": ["private_email"]})
                    self.assertEqual(local.execute(valid.sql).fetchall(), [(date(2026, 9, 1), "selected")])
                    self.assertEqual([x[0] for x in local.execute("DESCRIBE replica.main.events").fetchall()], ["event_date", "value"])
            finally:
                source.close()

    def test_row_byte_shape_and_date_escape_leave_no_replica(self):
        for failure in ["rows", "bytes", "shape", "date", "driver"]:
            c = self.contract()
            if failure == "bytes": c["limits"]["max_bytes"] = 1
            plan = self.prepare(c)
            extra = [(date(2026, 9, 1), "extra", "synthetic-private")] * 3 if failure == "rows" else []
            source = FixtureConnection(plan, extra)
            destination = self.base / (failure + ".duckdb")
            if failure == "shape":
                source.execute_selection = lambda *_: source.connection.execute("SELECT 'private' AS wrong")
            elif failure == "date":
                source.execute_selection = lambda *_: source.connection.execute("SELECT DATE '2025-01-01' AS event_date, 'x' AS value")
            elif failure == "driver":
                def broken(*_): raise RuntimeError("synthetic-private-password")
                source.execute_selection = broken
            try:
                with self.assertRaises(ConnectorError) as raised: materialize_synthetic(plan, source, destination)
                self.assertNotIn("synthetic-private-password", str(raised.exception))
                self.assertFalse(destination.exists())
                self.assertFalse(list(self.base.glob(".alg-connector-*")))
            finally: source.close()

    def test_cancel_no_overwrite_and_remote_activation_gate(self):
        plan = self.prepare(self.contract())
        source = FixtureConnection(plan)
        destination = self.base / "cancel.duckdb"
        try:
            with self.assertRaises(ConnectorError): materialize_synthetic(plan, source, destination, cancelled=lambda: True)
            self.assertFalse(source.initialized_sql)
            destination.write_bytes(b"preserve-existing")
            with self.assertRaises(ConnectorError): materialize_synthetic(plan, source, destination)
            self.assertEqual(destination.read_bytes(), b"preserve-existing")
            with self.assertRaises(DeploymentRequired): activate_remote(plan, approved=True, connection=source)
            with self.assertRaises(dataclasses.FrozenInstanceError): plan.sql = "SELECT *"
        finally: source.close()


if __name__ == "__main__":
    unittest.main()
