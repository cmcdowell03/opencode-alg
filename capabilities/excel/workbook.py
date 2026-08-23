"""Deterministic stage/check/validate CLI for staged .xlsx workbooks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from policy import (
    ExcelPolicyError,
    assert_absolute_source,
    canonical_root,
    policy_check,
    resolve_workbook,
)

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ZIP_ENTRIES = 4_096
MAX_ZIP_MEMBER_BYTES = 32 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_SHEETS = 128
MAX_CELLS = 500_000
MAX_FORMULAS = 100_000
MAX_FORMULA_CHARS = 8_192
MAX_DIMENSION_CELLS = 2_000_000
MAX_FINDINGS = 100
MAX_JSON_BYTES = 64 * 1024

REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DANGEROUS_FUNCTIONS = {
    "CALL",
    "EXEC",
    "FILTERXML",
    "HYPERLINK",
    "REGISTER.ID",
    "RTD",
    "WEBSERVICE",
}
EXTERNAL_FUNCTION_PREFIXES = ("CUBE",)
FUNCTION_RE = re.compile(r"(?<![A-Z0-9_.])([A-Z][A-Z0-9_.]*)\s*\(", re.IGNORECASE)
CELL_RE = re.compile(r"^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$", re.IGNORECASE)


class WorkbookValidationError(ValueError):
    pass


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _bounded_file(path: str) -> None:
    size = os.stat(path).st_size
    if size > MAX_FILE_BYTES:
        raise WorkbookValidationError(f"workbook exceeds {MAX_FILE_BYTES} bytes")


def stage(root_value: object, source_value: object, destination: object, overwrite: bool = False) -> dict[str, object]:
    root = canonical_root(root_value)
    source = assert_absolute_source(source_value)
    _bounded_file(source)
    target = resolve_workbook(root, destination, must_exist=False)
    if os.path.exists(target) and not overwrite:
        raise ExcelPolicyError("destination already exists; pass --overwrite explicitly")
    if os.path.exists(target) and os.path.samefile(source, target):
        raise ExcelPolicyError("source and destination must not alias")
    if os.path.normcase(source) == os.path.normcase(root):
        raise ExcelPolicyError("source and root must not alias")
    source_before = _sha256_file(source)
    parent = os.path.dirname(target)
    descriptor, temporary = tempfile.mkstemp(prefix=".alg-excel-stage-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as output, open(source, "rb") as input_file:
            shutil.copyfileobj(input_file, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        if _sha256_file(source) != source_before:
            raise WorkbookValidationError("source changed while it was being staged")
        if overwrite:
            os.replace(temporary, target)
            temporary = ""
        else:
            # A same-directory hard link publishes without overwriting a racing file.
            os.link(temporary, target)
            os.unlink(temporary)
            temporary = ""
        if _sha256_file(target) != source_before:
            raise WorkbookValidationError("staged copy hash differs from source")
        if _sha256_file(source) != source_before:
            raise WorkbookValidationError("source changed after staging")
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
    return {
        "bytes": os.stat(target).st_size,
        "destination": os.path.relpath(target, root).replace(os.sep, "/"),
        "ok": True,
        "overwrite": bool(overwrite),
        "sha256": source_before,
        "source_unchanged": True,
    }


def _xml(zipped: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        info = zipped.getinfo(name)
    except KeyError as error:
        raise WorkbookValidationError(f"missing OpenXML part: {name}") from error
    if info.file_size > MAX_ZIP_MEMBER_BYTES:
        raise WorkbookValidationError(f"OpenXML part exceeds {MAX_ZIP_MEMBER_BYTES} bytes: {name}")
    try:
        return ET.fromstring(zipped.read(info))
    except ET.ParseError as error:
        raise WorkbookValidationError(f"malformed XML part: {name}") from error


def _relationship_map(zipped: zipfile.ZipFile, name: str) -> tuple[dict[str, str], list[dict[str, str]]]:
    root = _xml(zipped, name)
    targets: dict[str, str] = {}
    external: list[dict[str, str]] = []
    for item in root.findall(f"{{{PKG_REL_NS}}}Relationship"):
        identifier = item.get("Id", "")
        target = item.get("Target", "")
        mode = item.get("TargetMode", "")
        rel_type = item.get("Type", "")
        if mode.lower() == "external":
            external.append({"part": name, "target": target[:512], "type": rel_type.rsplit("/", 1)[-1][:128]})
        elif identifier:
            targets[identifier] = target
    return targets, external


def _column_number(value: str) -> int:
    number = 0
    for character in value.upper():
        number = number * 26 + ord(character) - 64
    return number


def _dimension(ref: str | None) -> tuple[int, int, int] | None:
    if not ref:
        return None
    endpoints = ref.split(":")
    if len(endpoints) not in {1, 2}:
        return None
    parsed = [CELL_RE.match(item) for item in endpoints]
    if any(item is None for item in parsed):
        return None
    first = parsed[0]
    last = parsed[-1]
    assert first is not None and last is not None
    rows = int(last.group(2)) - int(first.group(2)) + 1
    columns = _column_number(last.group(1)) - _column_number(first.group(1)) + 1
    if rows < 1 or columns < 1:
        return None
    return rows, columns, rows * columns


def _formula_finding(sheet: str, cell: str, formula: str) -> dict[str, object] | None:
    upper = formula.upper()
    functions = sorted(set(match.group(1).upper() for match in FUNCTION_RE.finditer(formula)))
    dangerous = sorted(name for name in functions if name in DANGEROUS_FUNCTIONS or name.startswith(EXTERNAL_FUNCTION_PREFIXES))
    categories: list[str] = []
    if dangerous:
        categories.append("dangerous_or_external_function")
    if re.search(r"\[[^\]]+\]", formula) or re.search(r"(?:HTTPS?|FILE|FTP)://|\\\\|[A-Z]:\\", upper):
        categories.append("external_reference")
    if not categories:
        return None
    return {
        "categories": categories,
        "cell": cell[:32],
        "formula_sha256": hashlib.sha256(formula.encode("utf-8")).hexdigest(),
        "functions": dangerous,
        "sheet": sheet[:31],
    }


def _safe_part(base: str, target: str) -> str:
    if target.startswith("/"):
        candidate = target.lstrip("/")
    else:
        candidate = posixpath.normpath(posixpath.join(posixpath.dirname(base), target))
    if candidate.startswith("../") or candidate == ".." or "\x00" in candidate:
        raise WorkbookValidationError("worksheet relationship escapes the archive")
    return candidate


def validate(root_value: object, workbook: object) -> dict[str, object]:
    root = canonical_root(root_value)
    path = resolve_workbook(root, workbook, must_exist=True)
    _bounded_file(path)
    errors: list[str] = []
    findings: list[dict[str, object]] = []
    external: list[dict[str, str]] = []
    sheets: list[dict[str, object]] = []
    cell_count = 0
    formula_count = 0
    calc: dict[str, object] = {"freshness": "not_verified", "formulas_recalculated": False}
    try:
        with zipfile.ZipFile(path, "r") as zipped:
            infos = zipped.infolist()
            if len(infos) > MAX_ZIP_ENTRIES:
                raise WorkbookValidationError(f"ZIP contains more than {MAX_ZIP_ENTRIES} entries")
            names = [item.filename for item in infos]
            if len(names) != len(set(names)):
                raise WorkbookValidationError("ZIP contains duplicate member names")
            if sum(item.file_size for item in infos) > MAX_UNCOMPRESSED_BYTES:
                raise WorkbookValidationError(f"ZIP expands beyond {MAX_UNCOMPRESSED_BYTES} bytes")
            for info in infos:
                if info.flag_bits & 0x1:
                    raise WorkbookValidationError("encrypted ZIP members are unsupported")
                normalized = posixpath.normpath(info.filename)
                if normalized.startswith("../") or normalized.startswith("/") or normalized == "..":
                    raise WorkbookValidationError("ZIP member escapes the archive")
            for required in ("[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"):
                if required not in names:
                    raise WorkbookValidationError(f"missing OpenXML part: {required}")
            _xml(zipped, "[Content_Types].xml")
            workbook_root = _xml(zipped, "xl/workbook.xml")
            rels, workbook_external = _relationship_map(zipped, "xl/_rels/workbook.xml.rels")
            external.extend(workbook_external)
            for rel_name in sorted(name for name in names if name.endswith(".rels") and name != "xl/_rels/workbook.xml.rels"):
                _, found = _relationship_map(zipped, rel_name)
                external.extend(found)
            if any(name.startswith("xl/externalLinks/") for name in names):
                external.append({"part": "xl/externalLinks", "target": "embedded external-link part", "type": "externalLink"})
            calc_pr = workbook_root.find(f"{{{MAIN_NS}}}calcPr")
            if calc_pr is not None:
                calc.update({
                    "calc_mode": calc_pr.get("calcMode"),
                    "force_full_calculation_on_load": calc_pr.get("forceFullCalc") in {"1", "true"},
                    "full_calculation_on_load": calc_pr.get("fullCalcOnLoad") in {"1", "true"},
                })
            sheet_nodes = workbook_root.findall(f".//{{{MAIN_NS}}}sheet")
            if len(sheet_nodes) > MAX_SHEETS:
                raise WorkbookValidationError(f"workbook contains more than {MAX_SHEETS} sheets")
            seen_names: set[str] = set()
            for sheet_node in sheet_nodes:
                name = sheet_node.get("name", "")
                if not name or len(name) > 31 or any(character in name for character in "[]:*?/\\"):
                    errors.append(f"invalid sheet name at index {len(sheets)}")
                if name.casefold() in seen_names:
                    errors.append(f"duplicate sheet name at index {len(sheets)}")
                seen_names.add(name.casefold())
                rel_id = sheet_node.get(f"{{{REL_NS}}}id", "")
                target = rels.get(rel_id)
                if not target:
                    errors.append(f"sheet relationship is missing at index {len(sheets)}")
                    continue
                part = _safe_part("xl/workbook.xml", target)
                sheet_root = _xml(zipped, part)
                dimension_node = sheet_root.find(f"{{{MAIN_NS}}}dimension")
                dimension_ref = dimension_node.get("ref") if dimension_node is not None else None
                measured = _dimension(dimension_ref)
                if dimension_ref and measured is None:
                    errors.append(f"invalid dimension for sheet {len(sheets)}")
                elif measured and measured[2] > MAX_DIMENSION_CELLS:
                    errors.append(f"dimension exceeds {MAX_DIMENSION_CELLS} cells for sheet {len(sheets)}")
                sheet_cells = sheet_root.findall(f".//{{{MAIN_NS}}}c")
                cell_count += len(sheet_cells)
                if cell_count > MAX_CELLS:
                    raise WorkbookValidationError(f"workbook contains more than {MAX_CELLS} serialized cells")
                sheet_formulas = 0
                for cell in sheet_cells:
                    formula_node = cell.find(f"{{{MAIN_NS}}}f")
                    if formula_node is None:
                        continue
                    formula = formula_node.text or ""
                    formula_count += 1
                    sheet_formulas += 1
                    if formula_count > MAX_FORMULAS:
                        raise WorkbookValidationError(f"workbook contains more than {MAX_FORMULAS} formulas")
                    if len(formula) > MAX_FORMULA_CHARS:
                        errors.append(f"formula exceeds {MAX_FORMULA_CHARS} characters")
                        continue
                    finding = _formula_finding(name, cell.get("r", ""), formula)
                    if finding and len(findings) < MAX_FINDINGS:
                        findings.append(finding)
                sheets.append({
                    "cells": len(sheet_cells),
                    "dimension": dimension_ref,
                    "formulas": sheet_formulas,
                    "name": name,
                })
    except (zipfile.BadZipFile, KeyError, OSError, ET.ParseError) as error:
        raise WorkbookValidationError("invalid ZIP/OpenXML workbook") from error
    external = sorted(external, key=lambda item: (item["part"], item["type"], item["target"]))[:MAX_FINDINGS]
    errors = errors[:MAX_FINDINGS]
    ok = not errors and not findings and not external
    return {
        "bounds": {
            "max_cells": MAX_CELLS,
            "max_file_bytes": MAX_FILE_BYTES,
            "max_formula_chars": MAX_FORMULA_CHARS,
            "max_formulas": MAX_FORMULAS,
            "max_sheets": MAX_SHEETS,
        },
        "calculation": calc,
        "cells": cell_count,
        "errors": errors,
        "external_relationships": external,
        "formula_findings": findings,
        "formulas": formula_count,
        "ok": ok,
        "sha256": _sha256_file(path),
        "sheets": sheets,
        "workbook": os.path.relpath(path, root).replace(os.sep, "/"),
    }


def emit(value: dict[str, object]) -> None:
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
        raise WorkbookValidationError(f"JSON output exceeds {MAX_JSON_BYTES} bytes")
    sys.stdout.write(encoded + "\n")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog=Path(__file__).name)
    sub = result.add_subparsers(dest="command", required=True)
    check_parser = sub.add_parser("check")
    check_parser.add_argument("--root", required=True)
    stage_parser = sub.add_parser("stage")
    stage_parser.add_argument("--root", required=True)
    stage_parser.add_argument("--source", required=True)
    stage_parser.add_argument("--destination", required=True)
    stage_parser.add_argument("--overwrite", action="store_true")
    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--root", required=True)
    validate_parser.add_argument("--workbook", required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "check":
        emit({"ok": True, "policy": policy_check(args.root), "runtime": {"python": sys.version_info[:3]}})
    elif args.command == "stage":
        emit(stage(args.root, args.source, args.destination, args.overwrite))
    else:
        result = validate(args.root, args.workbook)
        emit(result)
        if not result["ok"]:
            return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit({"error": str(error)[:1024], "ok": False, "type": type(error).__name__})
        raise SystemExit(1)
