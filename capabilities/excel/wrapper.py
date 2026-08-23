"""Restricted stdio launcher for excel-mcp-server 0.1.8."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import logging
import sys
from pathlib import Path

from policy import ROOT_ENV, canonical_root, policy_check, resolve_workbook

UPSTREAM_DISTRIBUTION = "excel-mcp-server"
UPSTREAM_VERSION = "0.1.8"
TOOLS = (
    "apply_formula",
    "copy_range",
    "copy_worksheet",
    "create_chart",
    "create_pivot_table",
    "create_table",
    "create_workbook",
    "create_worksheet",
    "delete_range",
    "delete_sheet_columns",
    "delete_sheet_rows",
    "delete_worksheet",
    "format_range",
    "get_data_validation_info",
    "get_merged_cells",
    "get_workbook_metadata",
    "insert_columns",
    "insert_rows",
    "merge_cells",
    "read_data_from_excel",
    "rename_worksheet",
    "unmerge_cells",
    "validate_excel_range",
    "validate_formula_syntax",
    "write_data_to_excel",
)
MAX_CHECK_JSON = 16 * 1024


def _load_upstream(*, suppress_check_log: bool = False):
    original = logging.FileHandler
    if suppress_check_log:
        class NoFileHandler(logging.NullHandler):
            def __init__(self, *args, **kwargs):
                super().__init__()

        logging.FileHandler = NoFileHandler  # type: ignore[assignment]
    try:
        import excel_mcp.server as server
        return server
    finally:
        logging.FileHandler = original


def _tool_inventory(server: object) -> tuple[str, ...]:
    mcp = getattr(server, "mcp", None)
    manager = getattr(mcp, "_tool_manager", None)
    tools = getattr(manager, "_tools", None)
    if not isinstance(tools, dict) or len(tools) > 128:
        raise RuntimeError("upstream MCP tool registry is unavailable or oversized")
    names = tuple(sorted(tools))
    if any(not isinstance(name, str) or len(name) > 128 for name in names):
        raise RuntimeError("upstream MCP tool registry contains an unsafe name")
    return names


def check() -> dict[str, object]:
    root = canonical_root()
    version = importlib.metadata.version(UPSTREAM_DISTRIBUTION)
    if version != UPSTREAM_VERSION:
        raise RuntimeError(f"installed {UPSTREAM_DISTRIBUTION} version is not {UPSTREAM_VERSION}")
    server = _load_upstream(suppress_check_log=True)
    observed = _tool_inventory(server)
    if observed != TOOLS:
        raise RuntimeError("upstream MCP tool inventory does not match the capability manifest")
    path_status = policy_check(root)
    return {
        "distribution": UPSTREAM_DISTRIBUTION,
        "ok": True,
        "path_policy": path_status,
        "remote_transports": False,
        "tool_count": len(observed),
        "tools": list(observed),
        "version": version,
    }


def emit(value: dict[str, object]) -> None:
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_CHECK_JSON:
        raise RuntimeError("wrapper check output exceeded its bound")
    sys.stdout.write(encoded + "\n")


def run_server() -> None:
    root = canonical_root()
    server = _load_upstream()

    def confined_get_excel_path(filename: object) -> str:
        return resolve_workbook(root, filename)

    # Every 0.1.8 tool resolves these module globals at call time.
    server.EXCEL_FILES_PATH = root
    server.get_excel_path = confined_get_excel_path
    server.run_stdio()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog=Path(__file__).name)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.check:
        emit(check())
        return 0
    run_server()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # stderr is outside the MCP protocol stream; never put diagnostics on stdout.
        sys.stderr.write(f"alg-excel: {type(error).__name__}: {error}\n")
        raise SystemExit(1)
