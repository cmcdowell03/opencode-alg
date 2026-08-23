"""Filesystem policy for the opt-in ALG Excel capability.

This module deliberately imports no upstream MCP package so policy tests do not
trigger server/logging side effects.
"""

from __future__ import annotations

import ntpath
import os
import re
import stat
from pathlib import Path

ROOT_ENV = "ALG_EXCEL_ROOT"
XLSX_SUFFIX = ".xlsx"
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
RESERVED_DEVICE_RE = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$", re.IGNORECASE)


class ExcelPolicyError(ValueError):
    """A workbook path or root violates the capability contract."""


def _text(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ExcelPolicyError(f"{label} must be a string")
    if not value or "\x00" in value:
        raise ExcelPolicyError(f"{label} is empty or contains NUL")
    return value


def _normalized(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def _same_path(left: str, right: str) -> bool:
    return _normalized(left) == _normalized(right)


def _is_reparse(path: str) -> bool:
    info = os.lstat(path)
    attributes = int(getattr(info, "st_file_attributes", 0))
    return stat.S_ISLNK(info.st_mode) or bool(attributes & FILE_ATTRIBUTE_REPARSE_POINT)


def _within(root: str, candidate: str) -> bool:
    try:
        return os.path.commonpath([_normalized(root), _normalized(candidate)]) == _normalized(root)
    except ValueError:
        return False


def canonical_root(value: object | None = None) -> str:
    """Return a canonical existing dedicated directory or fail closed."""
    raw = _text(os.environ.get(ROOT_ENV) if value is None else value, ROOT_ENV)
    if not os.path.isabs(raw):
        raise ExcelPolicyError(f"{ROOT_ENV} must be absolute")
    absolute = os.path.abspath(raw)
    if not os.path.exists(absolute):
        raise ExcelPolicyError(f"{ROOT_ENV} must already exist")
    if not os.path.isdir(absolute):
        raise ExcelPolicyError(f"{ROOT_ENV} must be a directory")
    if _is_reparse(absolute):
        raise ExcelPolicyError(f"{ROOT_ENV} must not be a symlink, junction, or reparse point")
    real = os.path.realpath(absolute)
    if not _same_path(absolute, real):
        raise ExcelPolicyError(f"{ROOT_ENV} must be canonical and unredirected")
    if _same_path(real, os.path.dirname(real)):
        raise ExcelPolicyError(f"{ROOT_ENV} must be a dedicated directory, not a filesystem root")
    return real


def _relative_parts(value: object) -> tuple[str, list[str]]:
    raw = _text(value, "workbook path")
    if os.path.isabs(raw) or ntpath.isabs(raw):
        raise ExcelPolicyError("workbook path must be relative")
    parts = re.split(r"[\\/]", raw)
    if any(part in {"", ".", ".."} for part in parts):
        raise ExcelPolicyError("workbook path contains empty, dot, or traversal components")
    if any(":" in part for part in parts):
        raise ExcelPolicyError("workbook path contains an alternate-stream or drive separator")
    for part in parts:
        if part != part.rstrip(" ."):
            raise ExcelPolicyError("workbook path contains an ambiguous trailing space or dot")
        device_stem = part.split(".", 1)[0]
        if RESERVED_DEVICE_RE.fullmatch(device_stem):
            raise ExcelPolicyError("workbook path contains a reserved Win32 device alias")
    if not parts[-1].lower().endswith(XLSX_SUFFIX) or Path(parts[-1]).suffix.lower() != XLSX_SUFFIX:
        raise ExcelPolicyError("workbook path must end in .xlsx")
    return raw, parts


def _check_existing_components(root: str, parts: list[str]) -> None:
    current = root
    for part in parts:
        current = os.path.join(current, part)
        if not os.path.lexists(current):
            break
        if _is_reparse(current):
            raise ExcelPolicyError("workbook path traverses a symlink, junction, or reparse point")
        real = os.path.realpath(current)
        if not _within(root, real):
            raise ExcelPolicyError("workbook path escapes the dedicated root")


def resolve_workbook(
    root: object,
    relative_path: object,
    *,
    must_exist: bool = False,
    require_file: bool = True,
) -> str:
    """Resolve one relative .xlsx path beneath root without following redirects."""
    canonical = canonical_root(root)
    _, parts = _relative_parts(relative_path)
    candidate = os.path.join(canonical, *parts)
    _check_existing_components(canonical, parts)
    resolved = os.path.realpath(candidate)
    if not _within(canonical, resolved):
        raise ExcelPolicyError("workbook path escapes the dedicated root")
    exists = os.path.lexists(candidate)
    if must_exist and not exists:
        raise ExcelPolicyError("workbook does not exist")
    if exists:
        info = os.lstat(candidate)
        if _is_reparse(candidate):
            raise ExcelPolicyError("workbook must not be a symlink, junction, or reparse point")
        if require_file and not stat.S_ISREG(info.st_mode):
            raise ExcelPolicyError("workbook path must be a regular file")
    else:
        parent = os.path.dirname(candidate)
        if not os.path.isdir(parent) or _is_reparse(parent) or not _within(canonical, os.path.realpath(parent)):
            raise ExcelPolicyError("workbook parent must be an existing unredirected in-root directory")
    return resolved


def resolve_from_environment(relative_path: object, *, must_exist: bool = False) -> str:
    return resolve_workbook(canonical_root(), relative_path, must_exist=must_exist)


def assert_absolute_source(value: object) -> str:
    """Validate a read-only external source workbook for staging."""
    raw = _text(value, "source")
    if not os.path.isabs(raw):
        raise ExcelPolicyError("source must be absolute")
    absolute = os.path.abspath(raw)
    if Path(absolute).suffix.lower() != XLSX_SUFFIX:
        raise ExcelPolicyError("source must end in .xlsx")
    if not os.path.exists(absolute) or not os.path.isfile(absolute):
        raise ExcelPolicyError("source must be an existing regular file")
    if _is_reparse(absolute) or not _same_path(absolute, os.path.realpath(absolute)):
        raise ExcelPolicyError("source must be canonical and must not be a symlink, junction, or reparse point")
    return os.path.realpath(absolute)


def policy_check(root: object) -> dict[str, object]:
    """Exercise fail-closed probes without reading an external workbook."""
    canonical = canonical_root(root)
    probe = resolve_workbook(canonical, "alg-policy-probe.xlsx")
    rejected: list[str] = []
    cases = {
        "absolute": os.path.join(canonical, "absolute.xlsx"),
        "traversal": "../escape.xlsx",
        "nul": "bad\x00.xlsx",
        "extension": "bad.xlsm",
        "alternate_stream": "book.xlsx:stream",
        "reserved_device": "NUL.xlsx",
        "trailing_dot": "book.xlsx.",
    }
    for name, value in cases.items():
        try:
            resolve_workbook(canonical, value)
        except ExcelPolicyError:
            rejected.append(name)
    rejected.sort()
    if rejected != sorted(cases):
        raise ExcelPolicyError("rooted workbook policy self-check failed")
    return {
        "extension": XLSX_SUFFIX,
        "ok": True,
        "path_argument_confinement": True,
        "probe_relative": os.path.relpath(probe, canonical).replace(os.sep, "/"),
        "rejected": rejected,
        "root": canonical,
    }
