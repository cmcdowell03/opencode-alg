"""Versioned connector preparation only. No connection, extension load or install."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Mapping

ENGINE_VERSION = "1.4.0"
MAX_CONTRACT_BYTES = 128 * 1024
IDENTIFIER = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")
ENV_REF = re.compile(r"ALG_CONNECTOR_[A-Z][A-Z0-9_]{0,79}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
HOST = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}\Z")
TYPES = {"DATE", "VARCHAR", "BIGINT", "DOUBLE", "BOOLEAN"}


class ConnectorError(ValueError):
    """Public errors intentionally exclude supplied values and driver messages."""


class DeploymentRequired(ConnectorError):
    pass


def activate_remote(*_args: Any, **_kwargs: Any) -> None:
    raise DeploymentRequired("Remote activation is unavailable: independent deployment conformance required")


def canonical_bytes(value: Any) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                          allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise ConnectorError("Contract is not canonical JSON") from None


def contract_hash(value: Any) -> str:
    return hashlib.sha256(b"alg-connector-preparation-v1\0" + canonical_bytes(value)).hexdigest()


def load_json(raw: bytes) -> dict[str, Any]:
    if not isinstance(raw, bytes) or len(raw) > MAX_CONTRACT_BYTES:
        raise ConnectorError("Contract byte limit exceeded")

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ConnectorError("Duplicate contract key")
            result[key] = value
        return result

    def invalid_constant(_value: str) -> None:
        raise ConnectorError("Nonfinite contract number")

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ConnectorError("Invalid contract JSON") from None
    if type(value) is not dict:
        raise ConnectorError("Contract must be an object")
    return value


def keys(value: Any, required: set[str]) -> None:
    if type(value) is not dict or set(value) != required:
        raise ConnectorError("Contract object has missing or unknown fields")


def integer(value: Any, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ConnectorError("Integer is outside its contract bound")
    return value


def text(value: Any, pattern: re.Pattern[str]) -> str:
    if type(value) is not str or not pattern.fullmatch(value):
        raise ConnectorError("Invalid contract string")
    return value


def iso_date(value: Any) -> date:
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ConnectorError("Date must use YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ConnectorError("Invalid date") from None


def quoted(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def identifier(value: str) -> str:
    return '"' + text(value, IDENTIFIER) + '"'


def verify_file(path: Any, expected_hash: str) -> str:
    if type(path) is not str or len(path) > 4096 or any(ord(c) < 32 for c in path):
        raise ConnectorError("Invalid prepared file path")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ConnectorError("Prepared file must be absolute")
    try:
        info = candidate.lstat()
        resolved = candidate.resolve(strict=True)
        if (not stat.S_ISREG(info.st_mode) or candidate.is_symlink() or
                os.path.normcase(str(candidate)) != os.path.normcase(str(resolved)) or
                not 1 <= info.st_size <= 256 * 1024 * 1024):
            raise ConnectorError("Prepared file must be a bounded direct regular file")
        digest = hashlib.sha256()
        with candidate.open("rb") as stream:
            # Bound actual reads as well as stat size in case the file grows.
            remaining = 256 * 1024 * 1024 + 1
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                digest.update(chunk)
            if remaining == 0:
                raise ConnectorError("Prepared file byte limit exceeded")
        if digest.hexdigest() != expected_hash:
            raise ConnectorError("Prepared extension hash drift")
        return str(resolved)
    except OSError:
        raise ConnectorError("Prepared file cannot be verified") from None


@dataclass(frozen=True)
class PreparedSelection:
    contract_sha256: str
    kind: str
    engine_version: str
    platform: str
    relation_id: str
    columns: tuple[tuple[str, str], ...]
    date_column: str
    start: date
    end: date
    max_rows: int
    max_bytes: int
    initialization_templates: tuple[str, ...]
    sql: str
    extension_hashes: tuple[tuple[str, str], ...]
    # Presence checks, never values, are retained in preparation evidence.
    credential_refs: tuple[str, ...]
    metadata_sha256: str | None
    status: str = "PREPARED_NOT_ACTIVATED"


def prepare(
    contract: Any, *, expected_sha256: str, runtime_version: str, runtime_platform: str,
    approved_endpoints: frozenset[str], environment: Mapping[str, str],
    relation_id: str, start: str, end: str,
) -> PreparedSelection:
    """Verify reviewed operands and produce non-executable private-binding templates.

    runtime identity must come from the integration's actual engine, not the JSON.
    approved_endpoints and expected_sha256 are separately supplied review inputs.
    No environment values are returned, logged, put in SQL, or written to disk.
    """
    # Clone before validation, removing mutable aliases held by the caller.
    raw = canonical_bytes(contract)
    c = load_json(raw)
    text(expected_sha256, SHA)
    if contract_hash(c) != expected_sha256:
        raise ConnectorError("Reviewed contract hash mismatch")
    keys(c, {"schema_version", "mode", "kind", "engine", "extensions", "endpoint",
             "credential_refs", "relations", "limits"})
    if type(c["schema_version"]) is not int or c["schema_version"] != 1 or c["mode"] != "preparation_only":
        raise ConnectorError("Unsupported connector version or activation mode")
    if c["kind"] not in ("postgres", "iceberg_s3"):
        raise ConnectorError("Unsupported connector kind")
    keys(c["engine"], {"name", "version", "platform"})
    if (c["engine"]["name"] != "duckdb" or c["engine"]["version"] != ENGINE_VERSION or
            runtime_version != ENGINE_VERSION or c["engine"]["platform"] != runtime_platform):
        raise ConnectorError("Engine or platform identity drift")
    text(runtime_platform, re.compile(r"[a-z0-9_]{3,80}\Z"))
    limits = c["limits"]
    keys(limits, {"max_days", "max_rows", "max_bytes"})
    max_days = integer(limits["max_days"], 1, 366)
    max_rows = integer(limits["max_rows"], 1, 100_000)
    max_bytes = integer(limits["max_bytes"], 1, 64 * 1024 * 1024)
    first, last = iso_date(start), iso_date(end)
    if not 0 < (last - first).days <= max_days:
        raise ConnectorError("Selection date range is empty, reversed or too wide")

    endpoint = c["endpoint"]
    postgres = c["kind"] == "postgres"
    if postgres:
        keys(endpoint, {"host", "port", "database", "schema", "sslmode", "connect_timeout_seconds"})
        text(endpoint["host"], HOST)
        integer(endpoint["port"], 1, 65535)
        text(endpoint["database"], IDENTIFIER)
        text(endpoint["schema"], IDENTIFIER)
        if endpoint["sslmode"] != "verify-full":
            raise ConnectorError("PostgreSQL requires verify-full TLS")
        integer(endpoint["connect_timeout_seconds"], 1, 30)
        authority = f"postgresql://{endpoint['host']}:{endpoint['port']}/{endpoint['database']}"
        required_refs = {"username_env", "password_env"}
    else:
        keys(endpoint, {"host", "port", "region", "bucket", "prefix", "use_ssl", "url_style"})
        text(endpoint["host"], HOST)
        if endpoint["port"] != 443 or type(endpoint["port"]) is not int or endpoint["use_ssl"] is not True or endpoint["url_style"] != "path":
            raise ConnectorError("S3 requires HTTPS on port 443 with path addressing")
        text(endpoint["region"], re.compile(r"[a-z]{2}(?:-[a-z]+)+-[1-9]\Z"))
        text(endpoint["bucket"], re.compile(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\Z"))
        prefix = endpoint["prefix"]
        if (type(prefix) is not str or not re.fullmatch(r"(?:[a-zA-Z0-9_-]+/)+", prefix) or len(prefix) > 512):
            raise ConnectorError("S3 prefix must be an exact bounded directory prefix")
        authority = f"https://{endpoint['host']}:443/{endpoint['bucket']}/{prefix}"
        required_refs = {"key_id_env", "secret_env", "session_token_env"}
    if authority not in approved_endpoints:
        raise ConnectorError("Endpoint is outside separately reviewed scope")

    refs = c["credential_refs"]
    keys(refs, required_refs)
    for ref in refs.values():
        text(ref, ENV_REF)
        value = environment.get(ref)
        if type(value) is not str or not value.strip() or len(value.encode("utf-8")) > 8192 or any(ord(x) < 32 for x in value):
            raise ConnectorError("Required private environment binding is missing or invalid")
    if len(set(refs.values())) != len(refs):
        raise ConnectorError("Credential bindings must be distinct")

    required_extensions = ["postgres"] if postgres else ["httpfs", "iceberg"]
    if type(c["extensions"]) is not list or len(c["extensions"]) != len(required_extensions):
        raise ConnectorError("Exact prepared extension set required")
    statements = ["SET autoinstall_known_extensions = false;", "SET autoload_known_extensions = false;"]
    hashes = []
    for extension, name in zip(c["extensions"], required_extensions):
        keys(extension, {"name", "path", "sha256", "engine_version", "platform"})
        if extension["name"] != name or extension["engine_version"] != runtime_version or extension["platform"] != runtime_platform:
            raise ConnectorError("Prepared extension identity drift")
        digest = text(extension["sha256"], SHA)
        path = verify_file(extension["path"], digest)
        if Path(path).name != name + ".duckdb_extension":
            raise ConnectorError("Prepared extension filename mismatch")
        statements.append(f"LOAD {quoted(path)};")
        hashes.append((name, digest))

    relations = c["relations"]
    if type(relations) is not list or not 1 <= len(relations) <= 32:
        raise ConnectorError("Curated relation count outside bounds")
    ids: set[str] = set()
    selected = None
    for relation in relations:
        keys(relation, {"id", "source", "columns", "date_column", "available_start", "available_end"} |
             (set() if postgres else {"metadata_sha256"}))
        rid = text(relation["id"], IDENTIFIER)
        if rid in ids:
            raise ConnectorError("Duplicate curated relation")
        ids.add(rid)
        if postgres:
            text(relation["source"], IDENTIFIER)
        else:
            text(relation["metadata_sha256"], SHA)
            base = f"s3://{endpoint['bucket']}/{endpoint['prefix']}"
            source = relation["source"]
            if (type(source) is not str or not source.startswith(base) or len(source) > 2048 or
                    not re.fullmatch(r"(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.metadata\.json", source[len(base):])):
                raise ConnectorError("Iceberg requires an exact metadata object within the reviewed S3 prefix")
        if type(relation["columns"]) is not list or not 1 <= len(relation["columns"]) <= 64:
            raise ConnectorError("Curated column count outside bounds")
        names = set()
        for column in relation["columns"]:
            keys(column, {"name", "type"})
            name = text(column["name"], IDENTIFIER)
            if name in names or type(column["type"]) is not str or column["type"] not in TYPES:
                raise ConnectorError("Duplicate or unsupported curated column")
            names.add(name)
        if not any(x == {"name": relation["date_column"], "type": "DATE"} for x in relation["columns"]):
            raise ConnectorError("Partition date must be an explicitly selected DATE column")
        available_start, available_end = iso_date(relation["available_start"]), iso_date(relation["available_end"])
        if available_start >= available_end:
            raise ConnectorError("Invalid curated availability range")
        if rid == relation_id:
            if first < available_start or last > available_end:
                raise ConnectorError("Selection is outside curated availability")
            selected = relation
    if selected is None:
        raise ConnectorError("Relation is not curated")

    def private(key: str) -> str:
        # Deliberately NOT executable SQL. Only a future deployment adapter may
        # bind these privately after its engine-specific behavior is verified.
        return "${env:" + refs[key] + "}"

    if postgres:
        statements.append(f"CREATE TEMPORARY SECRET alg_source (TYPE postgres, HOST {quoted(endpoint['host'])}, "
                          f"PORT {endpoint['port']}, DATABASE {quoted(endpoint['database'])}, "
                          f"USER {private('username_env')}, PASSWORD {private('password_env')});")
        connection = (f"host={endpoint['host']} port={endpoint['port']} dbname={endpoint['database']} "
                      f"sslmode=verify-full connect_timeout={endpoint['connect_timeout_seconds']}")
        statements.append(f"ATTACH {quoted(connection)} AS source "
                          f"(TYPE postgres, READ_ONLY, SCHEMA {quoted(endpoint['schema'])}, SECRET alg_source);")
        source_sql = f"source.{identifier(endpoint['schema'])}.{identifier(selected['source'])}"
    else:
        statements.append(f"CREATE TEMPORARY SECRET alg_source (TYPE s3, PROVIDER config, "
                          f"KEY_ID {private('key_id_env')}, SECRET {private('secret_env')}, "
                          f"SESSION_TOKEN {private('session_token_env')}, REGION {quoted(endpoint['region'])}, "
                          f"ENDPOINT {quoted(endpoint['host'])}, USE_SSL true, URL_STYLE 'path', "
                          f"SCOPE {quoted('s3://' + endpoint['bucket'] + '/' + endpoint['prefix'])});")
        source_sql = f"iceberg_scan({quoted(selected['source'])}, allow_moved_paths = false)"
    columns = tuple((x["name"], x["type"]) for x in selected["columns"])
    date_sql = identifier(selected["date_column"])
    sql = (f"SELECT {', '.join(identifier(name) for name, _ in columns)} FROM {source_sql} "
           f"WHERE {date_sql} >= CAST(? AS DATE) AND {date_sql} < CAST(? AS DATE) LIMIT {max_rows + 1}")
    return PreparedSelection(contract_hash(c), c["kind"], runtime_version, runtime_platform,
                             relation_id, columns, selected["date_column"], first, last, max_rows,
                             max_bytes, tuple(statements), sql, tuple(hashes), tuple(sorted(refs.values())),
                             selected.get("metadata_sha256"))
