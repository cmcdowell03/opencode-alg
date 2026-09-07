"""Framework-neutral FastAPI-facing adapter; FastAPI remains optional."""
from __future__ import annotations

import asyncio
import threading
from typing import Any

try:
    from .query_plane import compatibility, preflight, query
except ImportError:
    from query_plane import compatibility, preflight, query


class DuckDBQueryAdapter:
    """Instantiate once per FastAPI process; every query still uses a disposable worker."""

    def __init__(self, contract_path: str, expected_contract_hash: str):
        loaded = preflight(contract_path, expected_contract_hash)
        self.contract_path = str(loaded.path)
        self.expected_contract_hash = loaded.sha256

    def compatibility(self) -> dict[str, Any]:
        # This creates a disposable process; OpenCode never shares this adapter's process.
        return compatibility(self.contract_path, self.expected_contract_hash)

    def execute(self, sql: str) -> dict[str, Any]:
        return query(self.contract_path, self.expected_contract_hash, sql)

    async def execute_async(self, sql: str) -> dict[str, Any]:
        """FastAPI-safe async entrypoint without blocking the event loop."""
        cancelled = threading.Event()
        task = asyncio.create_task(asyncio.to_thread(
            query, self.contract_path, self.expected_contract_hash, sql, cancelled,
        ))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled.set()
            # Do not finish request cancellation until supervision has reaped
            # the worker and attempted cleanup.
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    cancelled.set()
            task.result()
            raise
