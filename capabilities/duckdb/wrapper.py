"""Pinned local MCP stdio server and administrative CLI. No runtime installer."""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
from typing import Any

from query_plane import compatibility, preflight, query

SERVER_VERSION = "0.1.0"
PROTOCOL_VERSION = "2025-03-26"
MAX_MCP_MESSAGE_BYTES = 256 * 1024
_OUTPUT_LOCK = threading.Lock()
_RESPONSE_BYTE_CAP = MAX_MCP_MESSAGE_BYTES


def _public_error(error: Exception) -> str:
    value = re.sub(
        r"(?i)(password|passwd|token|secret|api[_-]?key|authorization|credential)\s*[:=]\s*[^\s,;]+",
        r"\1=[redacted]",
        str(error),
    )
    return value[:4_096]


def _reply(identifier: Any, result: Any = None, error: str | None = None, code: int = -32_000,
           byte_cap: int | None = None) -> None:
    byte_cap = byte_cap or _RESPONSE_BYTE_CAP
    if type(identifier) not in (str, int) or len(str(identifier)) > 128:
        identifier = None
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": identifier}
    if error is None:
        message["result"] = result
    else:
        message["error"] = {"code": code, "message": error[:4_096]}
    encoded = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if byte_cap is not None and len(encoded) > byte_cap:
        message = {"jsonrpc": "2.0", "id": identifier, "error": {"code": -32000, "message": "MCP response exceeds byte cap"}}
        encoded = (json.dumps(message, separators=(",", ":")) + "\n").encode()
    with _OUTPUT_LOCK:
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


def _read_message() -> dict[str, Any] | None:
    raw = sys.stdin.buffer.readline(MAX_MCP_MESSAGE_BYTES + 1)
    if raw == b"":
        return None
    if len(raw) > MAX_MCP_MESSAGE_BYTES or not raw.endswith(b"\n"):
        raise ValueError("MCP message exceeds the newline-delimited byte limit")
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
        raise ValueError("invalid JSON-RPC request")
    return request


def _tool_definition(max_sql_characters: int) -> dict[str, Any]:
    return {
        "name": "query",
        "description": "Run exactly one AST-policy-bounded query using the reviewed project DuckDB contract.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["sql"],
            "properties": {"sql": {"type": "string", "minLength": 1, "maxLength": max_sql_characters}},
        },
    }


def serve(contract_path: str, expected_hash: str) -> int:
    global _RESPONSE_BYTE_CAP
    loaded = preflight(contract_path, expected_hash)
    _RESPONSE_BYTE_CAP = loaded.contract["policy"].get("max_response_bytes", loaded.contract["policy"]["max_characters"])
    receipt = compatibility(str(loaded.path), loaded.sha256)
    if not receipt.get("ok"):
        raise RuntimeError("DuckDB compatibility preflight failed")
    initialized = False
    active: dict[Any, tuple[threading.Event, threading.Thread]] = {}
    active_lock = threading.Lock()

    def execute_call(identifier: Any, sql: str, cancelled: threading.Event) -> None:
        try:
            result = query(str(loaded.path), loaded.sha256, sql, cancelled)
            while True:
                payload = {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}],
                    "isError": not result.get("ok", False),
                }
                envelope = {"jsonrpc": "2.0", "id": identifier, "result": payload}
                if len((json.dumps(envelope, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")) <= _RESPONSE_BYTE_CAP:
                    break
                if result.get("rows"):
                    result["rows"].pop()
                    result["truncated"] = True
                else:
                    result = {"ok": False, "error": "MCP result metadata exceeds byte cap", "cleanup": result.get("cleanup")}
            _reply(identifier, payload)
        except Exception:
            _reply(identifier, error="query failed policy or execution validation")
        finally:
            with active_lock:
                active.pop(identifier, None)

    while True:
        request: dict[str, Any] | None = None
        try:
            request = _read_message()
            if request is None:
                with active_lock:
                    pending = list(active.values())
                for cancelled, thread in pending:
                    cancelled.set()
                for cancelled, thread in pending:
                    thread.join()
                return 0
            identifier = request.get("id")
            if "id" in request and (type(identifier) not in (str, int) or len(str(identifier)) > 128):
                raise ValueError("request id must be a bounded string or integer")
            method = request["method"]
            is_notification = "id" not in request
            if method == "initialize" and not is_notification:
                params = request.get("params")
                if not isinstance(params, dict):
                    _reply(identifier, error="initialize params must be an object", code=-32_602)
                    continue
                _reply(identifier, {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "alg-duckdb", "version": SERVER_VERSION},
                })
            elif method == "notifications/initialized" and is_notification:
                initialized = True
            elif method == "notifications/cancelled" and is_notification:
                params = request.get("params")
                if isinstance(params, dict):
                    with active_lock:
                        pending = active.get(params.get("requestId"))
                        if pending:
                            pending[0].set()
            elif method == "ping" and not is_notification:
                _reply(identifier, {})
            elif method == "tools/list" and not is_notification and initialized:
                _reply(identifier, {"tools": [_tool_definition(loaded.contract["policy"]["max_sql_characters"])]})
            elif method == "tools/call" and not is_notification and initialized:
                params = request.get("params")
                if not isinstance(params, dict) or params.get("name") != "query":
                    _reply(identifier, error="unsupported or invalid MCP tool call", code=-32_602)
                    continue
                arguments = params.get("arguments")
                if not isinstance(arguments, dict) or not isinstance(arguments.get("sql"), str) or not arguments["sql"].strip():
                    _reply(identifier, error="alg_duckdb_query requires only one SQL string", code=-32_602)
                    continue
                with active_lock:
                    if identifier in active or len(active) >= 2:
                        _reply(identifier, error="duplicate request id or query capacity busy")
                        continue
                    cancelled = threading.Event()
                    thread = threading.Thread(target=execute_call, args=(identifier, arguments["sql"], cancelled))
                    active[identifier] = (cancelled, thread)
                    thread.start()
            elif not is_notification:
                _reply(identifier, error="unsupported MCP method or invalid lifecycle state", code=-32_601)
        except Exception as error:
            identifier = request.get("id") if isinstance(request, dict) else None
            # Notifications never receive JSON-RPC responses.
            if isinstance(request, dict) and "id" not in request:
                continue
            _reply(identifier, error=_public_error(error), code=-32_600)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True)
    parser.add_argument("--hash", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--mcp", action="store_true")
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--query")
    args = parser.parse_args()
    loaded = preflight(args.contract, args.hash)
    if args.preflight:
        result = compatibility(str(loaded.path), loaded.sha256)
        sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        return 0 if result.get("ok") else 1
    if args.query is not None:
        result = query(str(loaded.path), loaded.sha256, args.query)
        sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        return 0 if result.get("ok") else 1
    return serve(str(loaded.path), loaded.sha256)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(_public_error(error), file=sys.stderr)
        raise SystemExit(1)
