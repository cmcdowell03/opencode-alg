"""Bounded local Arrow operations. No arbitrary SQL, Python, downloads, or network access."""
from __future__ import annotations
import hashlib
import io
import json
import math
import os
import stat
import re
import tempfile
from pathlib import Path
from typing import Any
import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as csv
import pyarrow.parquet as pq

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TABLE_BYTES = 64 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 64
SHA = re.compile(r"^[a-f0-9]{64}$")
DEVICE = re.compile(r"^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$", re.I)


def runtime_pins() -> None:
    if duckdb.__version__ != "1.4.0" or pa.__version__ != "21.0.0":
        raise ValueError("data-science runtime differs from the exact pins")

def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()

def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")

def direct_path(project: str, name: str, exists: bool = True) -> Path:
    if not isinstance(project, str):
        raise ValueError("project must be a path string")
    root = Path(project)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError("project must be an existing absolute directory")
    root = root.resolve(strict=True)
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError("use a nonempty portable project-relative path")
    relative = Path(name)
    if relative.is_absolute() or any(part in {"..", ".", ""} or any(ord(c) < 32 or c in ':*?<>|"' for c in part) or part.endswith((".", " ")) or DEVICE.fullmatch(part) for part in name.split("/")):
        raise ValueError("only project-relative direct paths are allowed")
    current = root
    for component in relative.parts:
        current = current / component
        if current.exists() or current.is_symlink():
            info = current.lstat()
            if current.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400 or os.path.normcase(str(current.resolve())) != os.path.normcase(str(current)):
                raise ValueError("redirected dataset path is prohibited")
    if exists and (not current.is_file() or not stat.S_ISREG(current.stat().st_mode)):
        raise ValueError("dataset must be a direct regular file")
    return current

def read_table(project: str, name: str) -> tuple[pa.Table, str]:
    path = direct_path(project, name)
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("input exceeds 8 MiB")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("input must remain a regular file")
        raw = stream.read(MAX_FILE_BYTES + 1)
        after = os.fstat(stream.fileno())
    current = direct_path(project, name).stat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if len(raw) > MAX_FILE_BYTES or identity(before) != identity(after) or identity(before) != identity(current):
        raise ValueError("input changed or exceeded its bound")
    if path.suffix.lower() == ".csv":
        table = csv.read_csv(pa.BufferReader(raw), read_options=csv.ReadOptions(use_threads=False))
    elif path.suffix.lower() == ".parquet":
        reader = pq.ParquetFile(pa.BufferReader(raw))
        metadata = reader.metadata
        if metadata.num_rows > MAX_ROWS or metadata.num_columns > MAX_COLUMNS or sum(metadata.row_group(i).total_byte_size for i in range(metadata.num_row_groups)) > MAX_TABLE_BYTES:
            raise ValueError("Parquet metadata exceeds decoded bounds")
        table = reader.read(use_threads=False)
    else:
        raise ValueError("only CSV and Parquet datasets are supported")
    if table.num_rows > MAX_ROWS or table.num_columns > MAX_COLUMNS or table.nbytes > MAX_TABLE_BYTES:
        raise ValueError("decoded dataset exceeds row/column/byte limits")
    if len(set(table.column_names)) != table.num_columns or any(len(c) > 128 for c in table.column_names):
        raise ValueError("duplicate or oversized column names are prohibited")
    if any(pa.types.is_nested(f.type) or pa.types.is_binary(f.type) or pa.types.is_large_binary(f.type) for f in table.schema):
        raise ValueError("nested and binary columns are outside this surface")
    return table, digest(raw)

def _number(value: Any) -> Any:
    return None if isinstance(value, float) and not math.isfinite(value) else value

def publish(project: str, raw: bytes, suffix: str, namespace: str = "data-science") -> dict[str, Any]:
    if not isinstance(raw, bytes) or len(raw) > MAX_TABLE_BYTES:
        raise ValueError("artifact exceeds byte bound")
    if suffix not in {"parquet", "json", "duckdb"} or namespace not in {"data-science", "experience"}:
        raise ValueError("invalid artifact kind")
    sha = digest(raw)
    name = f".opencode/{namespace}/artifacts/{sha}.{suffix}"
    path = direct_path(project, name, exists=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    direct_path(project, name, exists=False)
    if path.exists():
        if path.read_bytes() != raw:
            raise ValueError("immutable artifact conflict")
    else:
        fd, temporary = tempfile.mkstemp(prefix=".staged-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            direct_path(project, name, exists=False)
            try:
                os.link(temporary, path)
            except FileExistsError:
                if path.read_bytes() != raw:
                    raise ValueError("concurrent artifact conflict")
        finally:
            os.unlink(temporary)
    return {"path": name, "sha256": sha, "bytes": len(raw)}


def validate_request(request: Any) -> dict[str, Any]:
    allowed = {"operation", "source", "exclude_columns", "select_columns", "filter", "checks", "expected_source_sha256", "confirm"}
    if not isinstance(request, dict) or set(request) - allowed or not {"operation", "source", "exclude_columns"} <= set(request):
        raise ValueError("invalid request fields")
    if not isinstance(request["operation"], str) or request["operation"] not in {"preview", "profile", "validate", "import", "export"}:
        raise ValueError("unknown operation")
    if not isinstance(request["source"], str):
        raise ValueError("source must be a path string")
    for key in ("exclude_columns", "select_columns"):
        if key in request:
            value = request[key]
            if not isinstance(value, list) or len(value) > MAX_COLUMNS or any(not isinstance(c, str) or not c or len(c) > 128 for c in value) or len(set(value)) != len(value):
                raise ValueError("invalid column list")
    if "confirm" in request and type(request["confirm"]) is not bool:
        raise ValueError("confirm must be Boolean")
    if "expected_source_sha256" in request and (not isinstance(request["expected_source_sha256"], str) or not SHA.fullmatch(request["expected_source_sha256"])):
        raise ValueError("invalid source hash")
    if "filter" in request:
        condition = request["filter"]
        if not isinstance(condition, dict) or set(condition) != {"column", "equals"} or not isinstance(condition["column"], str) or type(condition["equals"]) not in (str, int, float, bool, type(None)):
            raise ValueError("invalid equality filter")
        if isinstance(condition["equals"], float) and not math.isfinite(condition["equals"]):
            raise ValueError("filter must be finite")
    checks = request.get("checks", [])
    if not isinstance(checks, list) or len(checks) > 64:
        raise ValueError("invalid quality checks")
    for check in checks:
        if not isinstance(check, dict) or set(check) != {"column", "kind"} or not isinstance(check["column"], str) or not isinstance(check["kind"], str) or check["kind"] not in {"not_null", "unique"}:
            raise ValueError("invalid quality check")
    if len(canonical(request)) > 65536:
        raise ValueError("request exceeds byte bound")
    return request

def run_operation(project: str, request: dict[str, Any]) -> dict[str, Any]:
    runtime_pins()
    request = validate_request(request)
    if not isinstance(request, dict) or set(request) - {"operation", "source", "exclude_columns", "select_columns", "filter", "checks", "expected_source_sha256", "confirm"}:
        raise ValueError("unknown request fields")
    operation = request.get("operation")
    if operation not in {"preview", "profile", "validate", "import", "export"}:
        raise ValueError("unknown operation")
    table, source_hash = read_table(project, request.get("source", ""))
    original_rows = table.num_rows
    excluded = request.get("exclude_columns")
    if not isinstance(excluded, list) or any(not isinstance(c, str) or c not in table.column_names for c in excluded) or len(set(excluded)) != len(excluded):
        raise ValueError("explicit valid exclude_columns is required; use [] only for reviewed non-sensitive data")
    table = table.drop(excluded)
    columns = request.get("select_columns", table.column_names)
    if not isinstance(columns, list) or not columns or any(not isinstance(c, str) or c not in table.column_names for c in columns) or len(set(columns)) != len(columns):
        raise ValueError("selected columns must be unique retained source columns")
    condition = request.get("filter")
    if condition is not None:
        if not isinstance(condition, dict) or set(condition) != {"column", "equals"} or condition["column"] not in table.column_names or not isinstance(condition["equals"], (str, int, float, bool, type(None))):
            raise ValueError("filter must be a typed equality on a retained column")
        column = table[condition["column"]]
        table = table.filter(pc.is_null(column) if condition["equals"] is None else pc.equal(column, condition["equals"]))
    table = table.select(columns)
    profile: list[dict[str, Any]] = []
    for field in table.schema:
        column = table[field.name]
        item = {"name": field.name, "type": str(field.type), "nulls": column.null_count, "distinct_nonnull": pc.count_distinct(column).as_py()}
        if pa.types.is_integer(field.type) or pa.types.is_floating(field.type):
            item.update({"mean": _number(pc.mean(column).as_py()), "population_stddev": _number(pc.stddev(column, ddof=0).as_py()), "min": _number(pc.min(column).as_py()), "max": _number(pc.max(column).as_py())})
        profile.append(item)
    checks = request.get("checks", [])
    if not isinstance(checks, list) or len(checks) > 64:
        raise ValueError("at most 64 checks are allowed")
    results = []
    for check in checks:
        if not isinstance(check, dict) or set(check) != {"column", "kind"} or check["column"] not in columns or check["kind"] not in {"not_null", "unique"}:
            raise ValueError("checks must be not_null or unique on retained columns")
        column = table[check["column"]]
        passed = column.null_count == 0 if check["kind"] == "not_null" else pc.count_distinct(column).as_py() == table.num_rows and column.null_count == 0
        results.append({**check, "passed": passed})
    receipt = {"schema_version": 1, "operation": operation, "source_sha256": source_hash, "request_sha256": digest(canonical(request)),
        "engine_version": duckdb.__version__, "arrow_version": pa.__version__, "source_rows": original_rows, "rows": table.num_rows,
        "columns": profile, "checks": results, "sample_rows": 0,
        "warnings": ["Descriptive statistics only; no causal or population inference.", "Decoded-data bounds are not an OS RSS ceiling."],
        "ok": all(item["passed"] for item in results)}
    if operation in {"import", "export"}:
        if request.get("confirm") is not True or request.get("expected_source_sha256") != source_hash:
            raise ValueError("staged writes require confirm:true and the exact preview source hash")
        if not receipt["ok"]:
            raise ValueError("failed quality checks prohibit export")
        sink = io.BytesIO()
        pq.write_table(table, sink, compression="zstd", use_dictionary=False)
        receipt["artifact"] = publish(project, sink.getvalue(), "parquet")
        receipt["receipt"] = publish(project, canonical(receipt), "json")
    return receipt
