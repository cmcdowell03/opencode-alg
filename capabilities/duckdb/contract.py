"""Strict, canonical, hash-verifiable DuckDB query-plane contract."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

SCHEMA_VERSION = 1
CAPABILITY_VERSION = "0.1.0"
ENGINE_VERSION = "1.4.0"
PARSER_VERSION = "27.14.0"
MAX_CONTRACT_BYTES = 128 * 1024
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
ENV_NAME = re.compile(r"^ALG_DUCKDB_[A-Z0-9_]{1,80}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SECRET_KEY = re.compile(r"(?:password|passwd|secret|token|api_?key|credential|access_?key)", re.I)
SIZE = re.compile(r"^([1-9]\d{0,5})(KB|MB|GB)$")


class ContractError(ValueError):
    """The contract or one of its private environment bindings is unsafe."""


@dataclass(frozen=True)
class ResolvedAttachment:
    alias: str
    source_env: str
    path: Path


@dataclass(frozen=True)
class LoadedContract:
    path: Path
    raw: bytes
    sha256: str
    contract: dict[str, Any]
    resolved_attachments: tuple[ResolvedAttachment, ...]


def canonical_contract_bytes(contract: Mapping[str, Any]) -> bytes:
    return json.dumps(contract, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def contract_hash(contract: Mapping[str, Any]) -> str:
    return hashlib.sha256(b"alg-duckdb-contract-v1\0" + canonical_contract_bytes(contract)).hexdigest()


def _keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    missing = expected - set(value)
    unknown = set(value) - expected
    if missing:
        raise ContractError(f"{label} is missing keys: {sorted(missing)}")
    if unknown:
        raise ContractError(f"{label} has unknown keys: {sorted(unknown)}")


def _integer(value: Any, label: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ContractError(f"{label} must be an integer in [{low}, {high}]")
    return value


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ContractError(f"{label} must be a plain SQL identifier")
    return value.lower()


def _relation(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{label} must be catalog.schema.relation")
    parts = value.split(".")
    if len(parts) != 3:
        raise ContractError(f"{label} must be catalog.schema.relation")
    return ".".join(_identifier(part, label) for part in parts)


def _size_bytes(value: Any, label: str, maximum: int) -> int:
    if not isinstance(value, str):
        raise ContractError(f"{label} must use an explicit KB, MB, or GB unit")
    match = SIZE.fullmatch(value)
    if not match:
        raise ContractError(f"{label} must use an explicit KB, MB, or GB unit")
    result = int(match.group(1)) * {"KB": 1_000, "MB": 1_000_000, "GB": 1_000_000_000}[match.group(2)]
    if result < 1_000_000 or result > maximum:
        raise ContractError(f"{label} is outside the supported resource bound")
    return result


def _no_plaintext_secrets(value: Any, path: str = "contract") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if SECRET_KEY.search(str(key)):
                raise ContractError(f"plaintext secret field is prohibited: {path}.{key}")
            _no_plaintext_secrets(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _no_plaintext_secrets(child, f"{path}[{index}]")


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _direct_regular_file(value: str | os.PathLike[str], label: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        raise ContractError(f"{label} must be an absolute regular file without redirects")
    try:
        before = candidate.lstat()
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ContractError(f"{label} must be an existing absolute regular file") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode) or not _same_path(candidate, resolved):
        raise ContractError(f"{label} must be an absolute regular file without redirects")
    return resolved


def _strict_json(raw: bytes) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ContractError(f"contract JSON contains duplicate key: {key}")
            result[key] = value
        return result

    def constant(_: str) -> Any:
        raise ContractError("contract JSON contains a non-finite number")

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except ContractError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError("contract is not valid UTF-8 JSON") from error


def validate_contract(contract: Any, environment: Mapping[str, str]) -> tuple[ResolvedAttachment, ...]:
    if not isinstance(contract, dict):
        raise ContractError("contract must be an object")
    _keys(
        contract,
        {"capability_version", "engine_version", "parser_version", "extensions", "settings", "attachments", "policy"},
        "contract",
    )
    _no_plaintext_secrets(contract)
    if contract["capability_version"] != CAPABILITY_VERSION:
        raise ContractError("capability_version differs from this query plane")
    if contract["engine_version"] != ENGINE_VERSION:
        raise ContractError("engine_version differs from the exactly pinned DuckDB runtime")
    if contract["parser_version"] != PARSER_VERSION:
        raise ContractError("parser_version differs from the exactly pinned SQL parser")
    # V1 deliberately has no extension loader. This is an exact empty inventory, not a best-effort check.
    if contract["extensions"] != []:
        raise ContractError("contract v1 requires an empty extension inventory")

    settings = contract["settings"]
    if not isinstance(settings, dict):
        raise ContractError("settings must be an object")
    _keys(settings, {"memory_limit", "threads", "max_temp_directory_size"}, "settings")
    _size_bytes(settings["memory_limit"], "settings.memory_limit", 16_000_000_000)
    _size_bytes(settings["max_temp_directory_size"], "settings.max_temp_directory_size", 64_000_000_000)
    _integer(settings["threads"], "settings.threads", 1, 16)

    attachments = contract["attachments"]
    if not isinstance(attachments, list) or len(attachments) > 16:
        raise ContractError("attachments must be an array of at most 16 entries")
    resolved: list[ResolvedAttachment] = []
    aliases: set[str] = set()
    env_names: set[str] = set()
    paths: set[str] = set()
    for index, attachment in enumerate(attachments):
        if not isinstance(attachment, dict):
            raise ContractError("attachment entries must be objects")
        _keys(attachment, {"alias", "source_env", "format", "read_only"}, f"attachments[{index}]")
        alias = _identifier(attachment["alias"], "attachment alias")
        if alias in {"memory", "system", "temp"} or alias in aliases:
            raise ContractError("attachment aliases must be unique and non-reserved")
        env_name = attachment["source_env"]
        if not isinstance(env_name, str) or not ENV_NAME.fullmatch(env_name) or env_name in env_names:
            raise ContractError("source_env must be a unique dedicated ALG_DUCKDB_* environment name")
        if attachment["format"] != "duckdb" or attachment["read_only"] is not True:
            raise ContractError("attachments must be format:duckdb and read_only:true")
        source = environment.get(env_name)
        if not source or "\x00" in source or len(source) > 4096:
            raise ContractError(f"required attachment file environment variable is absent or invalid: {env_name}")
        path = _direct_regular_file(source, f"attachment {env_name}")
        normalized_path = os.path.normcase(str(path))
        if normalized_path in paths:
            raise ContractError("attachment files must be unique")
        aliases.add(alias)
        env_names.add(env_name)
        paths.add(normalized_path)
        resolved.append(ResolvedAttachment(alias, env_name, path))

    policy = contract["policy"]
    if not isinstance(policy, dict):
        raise ContractError("policy must be an object")
    _keys(
        policy,
        {
            "allowed_relations", "protected_relations", "sensitive_columns", "max_sql_characters", "max_rows",
            "max_characters", "max_diagnostic_characters", "timeout_ms",
        },
        "policy",
    )
    allowed = policy["allowed_relations"]
    if not isinstance(allowed, list) or len(allowed) > 256:
        raise ContractError("allowed_relations must contain at most 256 relations")
    normalized = [_relation(item, "allowed relation") for item in allowed]
    if len(set(normalized)) != len(normalized):
        raise ContractError("allowed_relations contains duplicates")
    allowed_catalogs = {"memory", *aliases}
    if any(relation.split(".", 1)[0] not in allowed_catalogs for relation in normalized):
        raise ContractError("allowed relation catalog must be memory or a declared attachment alias")

    protected = policy["protected_relations"]
    if not isinstance(protected, dict) or len(protected) > 256:
        raise ContractError("protected_relations must be an object")
    normalized_protected: set[str] = set()
    for relation, columns in protected.items():
        normalized_relation = _relation(relation, "protected relation")
        if normalized_relation in normalized_protected or normalized_relation not in normalized:
            raise ContractError("protected relations must be unique and allowlisted")
        if not isinstance(columns, list) or not 1 <= len(columns) <= 16:
            raise ContractError("protected relation needs 1..16 required partition columns")
        normalized_columns = [_identifier(column, "partition column") for column in columns]
        if len(set(normalized_columns)) != len(normalized_columns):
            raise ContractError("required partition columns must be unique")
        normalized_protected.add(normalized_relation)

    sensitive = policy["sensitive_columns"]
    if not isinstance(sensitive, list) or len(sensitive) > 128:
        raise ContractError("sensitive_columns must be an array")
    normalized_sensitive = [_identifier(column, "sensitive column") for column in sensitive]
    if len(set(normalized_sensitive)) != len(normalized_sensitive):
        raise ContractError("sensitive_columns contains duplicates")
    _integer(policy["max_sql_characters"], "policy.max_sql_characters", 1, 100_000)
    _integer(policy["max_rows"], "policy.max_rows", 1, 10_000)
    _integer(policy["max_characters"], "policy.max_characters", 1_024, 2_000_000)
    _integer(policy["max_diagnostic_characters"], "policy.max_diagnostic_characters", 128, 32_768)
    _integer(policy["timeout_ms"], "policy.timeout_ms", 50, 120_000)
    return tuple(resolved)


def load_contract(
    path: str | os.PathLike[str],
    expected_hash: str,
    environment: Mapping[str, str] | None = None,
) -> LoadedContract:
    if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
        raise ContractError("expected contract hash must be lowercase SHA-256")
    contract_path = _direct_regular_file(path, "contract")
    before = contract_path.stat()
    if before.st_size > MAX_CONTRACT_BYTES:
        raise ContractError("contract exceeds byte limit")
    try:
        raw = contract_path.read_bytes()
    except OSError as error:
        raise ContractError("contract could not be read") from error
    after = contract_path.stat()
    if len(raw) != before.st_size or (before.st_dev, before.st_ino, before.st_mtime_ns) != (
        after.st_dev, after.st_ino, after.st_mtime_ns,
    ):
        raise ContractError("contract changed while it was being read")
    envelope = _strict_json(raw)
    if not isinstance(envelope, dict):
        raise ContractError("contract envelope must be an object")
    _keys(envelope, {"schema_version", "contract", "contract_sha256"}, "envelope")
    if envelope["schema_version"] != SCHEMA_VERSION:
        raise ContractError("unsupported contract schema_version")
    declared = envelope["contract_sha256"]
    if not isinstance(declared, str) or not SHA256.fullmatch(declared):
        raise ContractError("contract_sha256 must be lowercase SHA-256")
    actual = contract_hash(envelope["contract"]) if isinstance(envelope["contract"], dict) else ""
    if declared != actual or expected_hash != actual:
        raise ContractError("contract hash mismatch")
    resolved = validate_contract(envelope["contract"], environment if environment is not None else os.environ)
    return LoadedContract(contract_path, raw, actual, envelope["contract"], resolved)
