"""Disposable DuckDB worker, invoked only by the policy-enforcing parent."""
from __future__ import annotations

import json
import math
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import duckdb
import sqlglot

from contract import ContractError, LoadedContract, load_contract
from policy import PolicyError, validate_sql

MAX_REQUEST_BYTES = 256 * 1024


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _redaction_secrets() -> list[str]:
    return [value for key, value in os.environ.items() if key.startswith("ALG_DUCKDB_") and len(value) >= 4]


def _redact_text(value: str, cap: int) -> str:
    for secret in sorted(_redaction_secrets(), key=len, reverse=True):
        value = value.replace(secret, "[redacted]")
    value = re.sub(
        r"(?i)(password|passwd|token|secret|api[_-]?key|authorization|credential)\s*[:=]\s*[^\s,;]+",
        r"\1=[redacted]",
        value,
    )
    return value[:cap]


def _bytes(value: str) -> float:
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(KB|MB|GB|KiB|MiB|GiB)", value)
    if not match:
        raise ContractError("DuckDB returned an unrecognized effective size setting")
    decimal = match.group(2) in {"KB", "MB", "GB"}
    power = {"KB": 1, "KiB": 1, "MB": 2, "MiB": 2, "GB": 3, "GiB": 3}[match.group(2)]
    return float(match.group(1)) * ((1000 if decimal else 1024) ** power)


def _bool_setting(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if str(value).lower() in {"true", "1"}:
        return True
    if str(value).lower() in {"false", "0"}:
        return False
    raise ContractError("DuckDB returned an unrecognized boolean setting")


def _connect(loaded: LoadedContract, temporary_directory: str) -> tuple[duckdb.DuckDBPyConnection, dict[str, Any]]:
    settings = loaded.contract["settings"]
    config = {
        "memory_limit": settings["memory_limit"],
        "threads": str(settings["threads"]),
        "max_temp_directory_size": settings["max_temp_directory_size"],
        "temp_directory": temporary_directory,
        "autoinstall_known_extensions": "false",
        "autoload_known_extensions": "false",
        "allow_unsigned_extensions": "false",
        # Filesystem access is needed only for the parent-generated temp path and
        # fixed local replica attachments. Model SQL is independently AST-bound.
        "enable_external_access": "true",
    }
    connection = duckdb.connect(":memory:", config=config)
    try:
        connection.execute("SET home_directory = " + _quote_literal(temporary_directory))
        # ATTACH is trusted initialization generated from validated typed fields,
        # never model SQL. TYPE and READ_ONLY are fixed tokens.
        for attachment in loaded.resolved_attachments:
            connection.execute(
                f"ATTACH {_quote_literal(str(attachment.path))} AS {_quote_identifier(attachment.alias)} "
                "(TYPE DUCKDB, READ_ONLY)"
            )
        loaded_extensions = connection.execute(
            "SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY extension_name"
        ).fetchall()
        connection.execute("SET enable_external_access = false")
        connection.execute("SET lock_configuration = true")
        names = (
            "memory_limit", "threads", "max_temp_directory_size", "temp_directory",
            "autoinstall_known_extensions", "autoload_known_extensions", "allow_unsigned_extensions",
            "enable_external_access", "lock_configuration",
        )
        effective = {name: connection.execute("SELECT current_setting(?)", [name]).fetchone()[0] for name in names}
        if str(effective["threads"]) != str(settings["threads"]):
            raise ContractError("effective thread setting differs from contract")
        for key in ("memory_limit", "max_temp_directory_size"):
            actual_bytes, expected_bytes = _bytes(str(effective[key])), _bytes(settings[key])
            # DuckDB renders effective settings rounded to one decimal binary unit.
            if abs(actual_bytes - expected_bytes) > expected_bytes * 0.001:
                raise ContractError(f"effective {key} setting differs from contract")
        if not Path(str(effective["temp_directory"])).resolve().samefile(Path(temporary_directory).resolve()):
            raise ContractError("effective temporary directory differs from the disposable directory")
        expected_booleans = {
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "allow_unsigned_extensions": False,
            "enable_external_access": False,
            "lock_configuration": True,
        }
        if any(_bool_setting(effective[key]) is not expected for key, expected in expected_booleans.items()):
            raise ContractError("effective security setting differs from the contract boundary")
        effective["loaded_extensions"] = [row[0] for row in loaded_extensions]
        return connection, effective
    except Exception:
        connection.close()
        raise


def compatibility_receipt(loaded: LoadedContract, temporary_directory: str) -> tuple[duckdb.DuckDBPyConnection, dict[str, Any]]:
    if duckdb.__version__ != loaded.contract["engine_version"]:
        raise ContractError("DuckDB engine version differs from contract")
    if sqlglot.__version__ != loaded.contract["parser_version"]:
        raise ContractError("SQL parser version differs from contract")
    if loaded.contract["extensions"] != []:
        raise ContractError("extension inventory differs from the v1 empty inventory")
    connection, effective = _connect(loaded, temporary_directory)
    return connection, {
        "schema_version": 1,
        "capability_version": loaded.contract["capability_version"],
        "contract_sha256": loaded.sha256,
        "engine_version": duckdb.__version__,
        "parser_version": sqlglot.__version__,
        "extensions": list(loaded.contract["extensions"]),
        "extensions_kind": "requested_contract_inventory",
        "loaded_extensions": effective.pop("loaded_extensions"),
        "attachment_aliases": [attachment.alias for attachment in loaded.resolved_attachments],
        "effective_settings": effective,
    }


def _json_value(value: Any, cap: int) -> Any:
    if isinstance(value, (dict, list, tuple)):
        raise PolicyError("structured result values are prohibited")
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _redact_text(value if isinstance(value, str) else str(value), cap)


def _validate_catalog(connection: duckdb.DuckDBPyConnection, validated: Any) -> None:
    # Views can hide arbitrary source/function expansion. v1 admits base tables
    # only; every column must be scalar, including columns reached via stars.
    for relation in validated.relations:
        rows = connection.execute(
            "SELECT data_type FROM duckdb_columns() WHERE lower(database_name || '.' || schema_name || '.' || table_name)=?",
            [relation],
        ).fetchall()
        tables = connection.execute(
            "SELECT count(*) FROM duckdb_tables() WHERE lower(database_name || '.' || schema_name || '.' || table_name)=?",
            [relation],
        ).fetchone()[0]
        if tables != 1 or not rows:
            raise PolicyError("only verified physical base tables are supported")
        if any(any(token in row[0].upper() for token in ("STRUCT", "MAP", "UNION", "[")) for row in rows):
            raise PolicyError("structured source columns are prohibited")
    # Qualified references and no nested stars make explicit sensitive-name
    # rejection sufficient for supported scalar projections. Whole-row alias
    # references are already rejected by the policy's qualification rule.


def _strict_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict) or set(request) != {
        "operation", "contract_path", "expected_hash", "temporary_directory", "sql",
    }:
        raise ContractError("worker request shape is invalid")
    if request["operation"] not in {"compatibility", "query"}:
        raise ContractError("worker operation is invalid")
    if request["operation"] == "compatibility" and request["sql"] is not None:
        raise ContractError("compatibility request must not contain SQL")
    if request["operation"] == "query" and not isinstance(request["sql"], str):
        raise ContractError("query request SQL is invalid")
    temporary = Path(request["temporary_directory"])
    if not temporary.is_absolute() or not temporary.is_dir() or temporary.is_symlink():
        raise ContractError("worker temporary directory is invalid")
    return request


def execute(request: Any) -> dict[str, Any]:
    request = _strict_request(request)
    loaded = load_contract(request["contract_path"], request["expected_hash"])
    policy = loaded.contract["policy"]
    validated = validate_sql(request["sql"], policy) if request["operation"] == "query" else None
    if validated is not None:
        statements = duckdb.extract_statements(validated.sql)
        expected_type = "StatementType.EXPLAIN" if validated.explain else "StatementType.SELECT"
        if len(statements) != 1 or str(statements[0].type) != expected_type:
            raise PolicyError("DuckDB parser classification differs from the reviewed AST classification")
    connection, compatibility = compatibility_receipt(loaded, request["temporary_directory"])
    try:
        if validated is None:
            return {"ok": True, "compatibility": compatibility}
        _validate_catalog(connection, validated)
        cursor = connection.execute(validated.sql)
        columns = [str(item[0]) for item in (cursor.description or [])]
        sensitive = {name.lower() for name in policy["sensitive_columns"]}
        redacted_indexes = {index for index, name in enumerate(columns) if name.lower() in sensitive}
        result: dict[str, Any] = {
            "ok": True,
            "columns": columns,
            "rows": [],
            "truncated": False,
            "compatibility": compatibility,
        }
        cap = policy["max_characters"]
        while len(result["rows"]) < policy["max_rows"]:
            row = cursor.fetchone()
            if row is None:
                break
            encoded = [
                "[redacted]" if index in redacted_indexes else _json_value(value, cap)
                for index, value in enumerate(row)
            ]
            result["rows"].append(encoded)
            if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > cap:
                result["rows"].pop()
                result["truncated"] = True
                break
        if len(result["rows"]) == policy["max_rows"] and cursor.fetchone() is not None:
            result["truncated"] = True
        while len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > cap and result["rows"]:
            result["rows"].pop()
            result["truncated"] = True
        if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > cap:
            raise RuntimeError("result metadata exceeds character cap")
        return result
    finally:
        connection.close()


def main() -> int:
    # Windows ownership uses a kill-on-close Job assigned before stdin is sent.
    # On POSIX, orphan detection stops a worker even after abrupt host death.
    if os.name != "nt":
        parent = int(os.environ.get("ALG_DUCKDB_PARENT_PID", "0"))
        if parent <= 1 or os.getppid() != parent:
            return 1
        def watch_parent() -> None:
            while os.getppid() == parent:
                time.sleep(0.1)
            os._exit(1)
        threading.Thread(target=watch_parent, daemon=True).start()
    request: Any = None
    cap = 4_096
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ContractError("worker request exceeds byte limit")
        request = _strict_request(json.loads(raw))
        loaded = load_contract(request["contract_path"], request["expected_hash"])
        cap = loaded.contract["policy"]["max_diagnostic_characters"]
        result = execute(request)
    except Exception as error:
        result = {"ok": False, "error": _redact_text(str(error), cap)}
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    # Success is bounded by max_characters in execute; diagnostics use their
    # own smaller contract cap. UTF-8 framing is bounded again by the parent.
    sys.stdout.buffer.write(encoded.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
