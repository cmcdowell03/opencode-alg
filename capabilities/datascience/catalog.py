"""Derived catalog builder. Source outbox remains authoritative; no model-supplied SQL."""
from __future__ import annotations
import json
import os
import re
import tempfile
import math
import datetime
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any
import duckdb
try:
    from .operations import canonical, digest, direct_path, publish, runtime_pins
except ImportError:
    from operations import canonical, digest, direct_path, publish, runtime_pins

SHA = re.compile(r"^[a-f0-9]{64}$")
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
RESERVED = {"constructor", "hasownproperty", "isprototypeof", "propertyisenumerable", "prototype", "tolocalestring", "tostring", "valueof"}
KINDS = {"experience", "source_artifact", "attempt", "observation", "outcome", "dataset", "incident", "hypothesis", "action", "skill_version", "candidate", "evaluation"}


def _hash(value: Any) -> bool:
    return isinstance(value, str) and SHA.fullmatch(value) is not None


def _id(value: Any) -> bool:
    return isinstance(value, str) and ID.fullmatch(value) is not None and value.lower() not in RESERVED and not re.match(r"^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$", value, re.I)


def source_canonical(value: Any) -> bytes:
    """TS canonicalJson bridge for this finite, ASCII-keyed schema.

    Numeric metrics use ECMAScript's fixed/exponent boundaries; this identity
    remains separate from the Python logical-row and physical-file checksums.
    """
    def encode(item: Any) -> str:
        if isinstance(item, dict):
            keys = sorted(item, key=lambda k: (0, int(k)) if k.isascii() and k.isdigit() and str(int(k)) == k and int(k) < 4294967295 else (1, k))
            return "{" + ",".join(encode(k) + ":" + encode(item[k]) for k in keys) + "}"
        if isinstance(item, list):
            return "[" + ",".join(encode(v) for v in item) + "]"
        if type(item) in (int, float):
            if not math.isfinite(item):
                raise ValueError("nonfinite source number")
            if item == 0:
                return "0"
            number = repr(float(item)) if isinstance(item, float) else str(item)
            if 1e-6 <= abs(item) < 1e21:
                return format(Decimal(number), "f").rstrip("0").rstrip(".") if "." in format(Decimal(number), "f") else format(Decimal(number), "f")
            mantissa, exponent = format(Decimal(number).normalize(), "e").split("e")
            exp_value = int(exponent)
            return mantissa + "e" + ("+" if exp_value >= 0 else "-") + str(abs(exp_value))
        return json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return encode(value).encode("utf-8")


def project_identity(project: str) -> str:
    if not isinstance(project, str) or not Path(project).is_absolute() or not Path(project).is_dir():
        raise ValueError("invalid project directory")
    path = str(Path(project).resolve(strict=True))
    if os.name == "nt":
        if path.startswith("\\\\?\\UNC\\"):
            path = "\\\\" + path[8:]
        elif path.startswith("\\\\?\\"):
            path = path[4:]
        path = path.lower()
    return digest(canonical(path))


def validate_record(record: Any, project_hash: str) -> None:
    fields = {"schema_version", "id", "project", "kind", "source", "observed_at", "privacy", "retention", "status", "summary", "skill_version", "group", "relations", "metrics"}
    if not isinstance(record, dict) or set(record) != fields or type(record["schema_version"]) is not int or record["schema_version"] != 1 or record["project"] != project_hash or record["privacy"] != "project-private":
        raise ValueError("catalog record shape or scope mismatch")
    for key, choices in (("kind", KINDS), ("retention", {"operational", "evaluation", "archival"}), ("status", {"observed", "inferred", "success", "failure", "indeterminate", "abstained"})):
        if not isinstance(record[key], str) or record[key] not in choices:
            raise ValueError("invalid catalog enum")
    if not _hash(record["id"]) or not _id(record["group"]) or record["skill_version"] is not None and not _hash(record["skill_version"]):
        raise ValueError("invalid catalog identity")
    source = record["source"]
    if not isinstance(source, dict) or set(source) != {"type", "id", "sha256"} or not _id(source["type"]) or not _id(source["id"]) or not _hash(source["sha256"]):
        raise ValueError("invalid source reference")
    if not isinstance(record["summary"], str) or not 1 <= len(record["summary"].encode("utf-16-le")) // 2 <= 2000:
        raise ValueError("invalid summary")
    timestamp = record["observed_at"]
    if not isinstance(timestamp, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", timestamp):
        raise ValueError("invalid observation time")
    datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    relations = record["relations"]
    if not isinstance(relations, list) or len(relations) > 64:
        raise ValueError("invalid relations")
    for relation in relations:
        if not isinstance(relation, dict) or set(relation) != {"kind", "id"} or not isinstance(relation["kind"], str) or relation["kind"] not in {"derived_from", "supports", "refutes", "tests", "produced", "applied", "evaluates", "supersedes"} or not _hash(relation["id"]):
            raise ValueError("invalid relation")
    metrics = record["metrics"]
    if not isinstance(metrics, dict) or len(metrics) > 32 or any(not _id(k) or v is not None and (type(v) not in (int, float) or not math.isfinite(v)) for k, v in metrics.items()):
        raise ValueError("invalid metrics")
    if digest(source_canonical({k: v for k, v in record.items() if k != "id"})) != record["id"]:
        raise ValueError("catalog object content hash mismatch")

def rebuild_catalog(project: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    runtime_pins()
    if not isinstance(snapshot, dict) or set(snapshot) != {"schema_version", "project", "source_count", "logical_sha256", "records"} or type(snapshot["schema_version"]) is not int or snapshot["schema_version"] != 1:
        raise ValueError("unsupported catalog snapshot")
    records = snapshot["records"]
    if not isinstance(records, list) or len(records) > 10_000 or type(snapshot["source_count"]) is not int or snapshot["source_count"] != len(records) or len(canonical(snapshot)) > 8 * 1024 * 1024:
        raise ValueError("catalog source count mismatch")
    if not isinstance(snapshot["project"], str) or not SHA.fullmatch(snapshot["project"]):
        raise ValueError("invalid project identity")
    if snapshot["project"] != project_identity(project):
        raise ValueError("catalog snapshot belongs to another project")
    if not _hash(snapshot["logical_sha256"]) or digest(source_canonical(records)) != snapshot["logical_sha256"]:
        raise ValueError("catalog snapshot content hash mismatch")
    seen = set()
    rows = []
    for record in records:
        validate_record(record, snapshot["project"])
        if not isinstance(record, dict) or record.get("schema_version") != 1 or record.get("project") != snapshot["project"] or record.get("privacy") != "project-private":
            raise ValueError("catalog record scope mismatch")
        identity = record.get("id")
        if not isinstance(identity, str) or not SHA.fullmatch(identity) or identity in seen:
            raise ValueError("duplicate or invalid catalog object")
        seen.add(identity)
        payload = canonical(record).decode("utf-8")
        if len(payload.encode("utf-8")) > 32768:
            raise ValueError("oversized catalog record")
        rows.append((identity, record["kind"], record["status"], record["group"], record["skill_version"], record["observed_at"], payload))
    rows.sort()
    # This is a versioned Python logical-row checksum, not the TS object hash or
    # the physical database bytes. Both source and derived identities are retained.
    logical_hash = digest(canonical(rows))
    root = direct_path(project, ".opencode/experience/catalog-staging", exists=False)
    root.mkdir(parents=True, exist_ok=True)
    direct_path(project, ".opencode/experience/catalog-staging", exists=False)
    lock = root / "writer.lock"
    try:
        descriptor = lock.open("xb")
    except FileExistsError as error:
        raise ValueError("catalog writer lock exists; inspect a potentially interrupted rebuild") from error
    try:
        token = ("catalog-v1:" + uuid.uuid4().hex + "\n").encode()
        owned = os.fstat(descriptor.fileno())
        with descriptor:
            descriptor.write(token)
        with tempfile.TemporaryDirectory(prefix="build-", dir=root) as temporary:
            path = Path(temporary, "catalog.duckdb")
            connection = duckdb.connect(str(path), config={"enable_external_access": "false", "autoinstall_known_extensions": "false", "autoload_known_extensions": "false", "memory_limit": "128MB", "threads": "1", "max_temp_directory_size": "0B"})
            try:
                connection.execute("CREATE TABLE records(id VARCHAR PRIMARY KEY, kind VARCHAR, status VARCHAR, group_id VARCHAR, skill_version VARCHAR, observed_at VARCHAR, payload VARCHAR)")
                if rows:
                    connection.executemany("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
                observed = connection.execute("SELECT * FROM records ORDER BY id").fetchall()
                if observed != rows:
                    raise ValueError("catalog did not reconstruct exact logical rows")
                connection.execute("CHECKPOINT")
            finally:
                connection.close()
            artifact = publish(project, path.read_bytes(), "duckdb", "experience")
        return {"schema_version": 1, "source_logical_sha256": snapshot["logical_sha256"], "logical_rows_sha256": logical_hash,
            "rows": len(rows), "artifact": artifact, "authoritative": False, "engine_version": duckdb.__version__}
    finally:
        # Never remove a lock that was replaced while this writer ran.
        try:
            current = lock.lstat()
            if not lock.is_symlink() and (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino) and current.st_size == len(token) and lock.read_bytes() == token:
                lock.unlink()
        except FileNotFoundError:
            pass
