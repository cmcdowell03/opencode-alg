"""Synthetic-only rehearsal of bounded curated transfer into a local DuckDB replica.

No remote driver implementation is registered here. Initialization templates are
recorded by the supplied fixture adapter, never executed by this module.
"""
from __future__ import annotations

import hashlib
import math
import os
import shutil
import tempfile
from datetime import date
from pathlib import Path
from typing import Any, Callable, Protocol, Sequence

from .contract import ConnectorError, PreparedSelection, canonical_bytes, identifier


class SyntheticConnection(Protocol):
    def initialize_preview(self, statements: tuple[str, ...]) -> None:
        """Record unbound initialization SQL only; never execute remote operations."""

    def execute_selection(self, sql: str, parameters: tuple[str, str]) -> Any:
        """Return a DB-API cursor backed solely by synthetic/local fixture data."""


def _row(values: Sequence[Any], plan: PreparedSelection) -> tuple[tuple[Any, ...], bytes]:
    if not isinstance(values, (tuple, list)) or len(values) != len(plan.columns):
        raise ConnectorError("Source row shape violates curated selection")
    serialized = []
    for value, (name, kind) in zip(values, plan.columns):
        if value is None:
            if name == plan.date_column:
                raise ConnectorError("Partition date cannot be null")
        elif kind == "DATE":
            if type(value) is not date:
                raise ConnectorError("Source value violates DATE contract")
            if name == plan.date_column and not plan.start <= value < plan.end:
                raise ConnectorError("Source row escaped selection date window")
        elif kind == "VARCHAR":
            if type(value) is not str:
                raise ConnectorError("Source value violates VARCHAR contract")
        elif kind == "BIGINT":
            if type(value) is not int or not -(2**63) <= value < 2**63:
                raise ConnectorError("Source value violates BIGINT contract")
        elif kind == "DOUBLE":
            if type(value) is not float or not math.isfinite(value):
                raise ConnectorError("Source value violates finite DOUBLE contract")
        elif kind == "BOOLEAN":
            if type(value) is not bool:
                raise ConnectorError("Source value violates BOOLEAN contract")
        else:
            raise ConnectorError("Unsupported result type")
        serialized.append(value.isoformat() if type(value) is date else value)
    return tuple(values), canonical_bytes(serialized) + b"\n"


def materialize_synthetic(
    plan: PreparedSelection, connection: SyntheticConnection, destination: Path,
    *, cancelled: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Exercise a supplied synthetic connection; publish only complete bounded output.

    Caller owns the fixture connection and closes it. This synchronous adapter
    does not promise preemption of a blocked fetch or bound remote resource use.
    Its protocol is an integration seam, not a sandbox for untrusted Python.
    """
    import duckdb  # prepared local environment, no download/install fallback

    if plan.status != "PREPARED_NOT_ACTIVATED":
        raise ConnectorError("Only prepared synthetic selections may be rehearsed")
    if duckdb.__version__ != plan.engine_version:
        raise ConnectorError("Local replica engine identity drift")
    destination = Path(destination)
    if (not destination.is_absolute() or destination.suffix != ".duckdb" or
            not destination.parent.is_dir() or destination.exists() or destination.is_symlink() or
            os.path.normcase(str(destination.parent)) != os.path.normcase(str(destination.parent.resolve()))):
        raise ConnectorError("Destination must be a new local DuckDB file under a direct existing directory")
    if cancelled():
        raise ConnectorError("Synthetic materialization cancelled")
    directory = Path(tempfile.mkdtemp(prefix=".alg-connector-", dir=destination.parent))
    stage = directory / "replica.duckdb"
    local = None
    committed = False
    try:
        local = duckdb.connect(str(stage), config={"autoinstall_known_extensions": "false",
            "autoload_known_extensions": "false", "enable_external_access": "false", "threads": "1",
            "memory_limit": "128MB", "max_temp_directory_size": "64MB"})
        if local.execute("PRAGMA platform").fetchone()[0] != plan.platform:
            raise ConnectorError("Local replica platform identity drift")
        connection.initialize_preview(plan.initialization_templates)
        if cancelled():
            raise ConnectorError("Synthetic materialization cancelled")
        cursor = connection.execute_selection(plan.sql, (plan.start.isoformat(), plan.end.isoformat()))
        expected_columns = [name for name, _kind in plan.columns]
        if not cursor.description or [entry[0] for entry in cursor.description] != expected_columns:
            raise ConnectorError("Source columns differ from exact curated projection")
        table = identifier(plan.relation_id)
        local.execute(f"CREATE TABLE {table} ({', '.join(identifier(name) + ' ' + kind for name, kind in plan.columns)})")
        local.execute("BEGIN TRANSACTION")
        count, byte_count = 0, 0
        digest = hashlib.sha256()
        while True:
            if cancelled():
                raise ConnectorError("Synthetic materialization cancelled")
            requested = min(256, plan.max_rows + 1 - count)
            rows = cursor.fetchmany(requested)
            if not rows:
                break
            if len(rows) > requested or count + len(rows) > plan.max_rows:
                raise ConnectorError("Curated row bound exceeded; replica was not published")
            bounded = []
            for values in rows:
                row, raw = _row(values, plan)
                byte_count += len(raw)
                if byte_count > plan.max_bytes:
                    raise ConnectorError("Curated logical byte bound exceeded; replica was not published")
                digest.update(raw)
                bounded.append(row)
            local.executemany(f"INSERT INTO {table} VALUES ({', '.join('?' for _ in plan.columns)})", bounded)
            count += len(rows)
        if cancelled():
            raise ConnectorError("Synthetic materialization cancelled")
        local.execute("COMMIT")
        local.close()
        local = None
        # Atomic create-if-absent. A concurrent destination is never replaced.
        os.link(stage, destination)
        committed = True
        return {
            "schema_version": 1, "status": "SYNTHETIC_REPLICA_ONLY", "remote_activated": False,
            "contract_sha256": plan.contract_sha256, "engine_version": plan.engine_version,
            "platform": plan.platform, "relation": f"main.{plan.relation_id}",
            "start_inclusive": plan.start.isoformat(), "end_exclusive": plan.end.isoformat(),
            "rows": count, "logical_bytes": byte_count, "ordered_rows_sha256": digest.hexdigest(),
            "remote_pushdown": "NOT_MEASURED", "remote_resource_limits": "NOT_MEASURED",
            "extension_abi": "NOT_MEASURED", "remote_metadata_hash": "NOT_VERIFIED",
            "destination": str(destination),
        }
    except ConnectorError:
        raise
    except Exception:
        # Drivers may include private SQL, credentials or returned values.
        raise ConnectorError("Synthetic transfer failed; private driver details suppressed") from None
    finally:
        try:
            if local is not None:
                local.close()
            shutil.rmtree(directory)
        except Exception:
            state = "replica committed" if committed else "replica not committed"
            raise ConnectorError(f"Synthetic staging cleanup failed ({state}); manual staging inspection required") from None
