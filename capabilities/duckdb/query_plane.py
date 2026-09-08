"""Parent-enforced process, timeout, and serialization boundary for all adapters."""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Mapping

_ADMISSION = threading.BoundedSemaphore(2)


class _WindowsJob:
    """Kill workers on owner death, including abrupt MCP/ASGI host exit."""

    def __init__(self, process: subprocess.Popen[bytes]):
        import ctypes
        from ctypes import wintypes

        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("minimum", ctypes.c_size_t),
                        ("maximum", ctypes.c_size_t), ("active", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                        ("scheduling", wintypes.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                        ("peak_job", ctypes.c_size_t)]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        self.api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("worker lifetime job creation failed")
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            self.close()
            raise OSError("worker lifetime job assignment failed")

    def close(self) -> None:
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


def _encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def bound_response(response: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    """Bound the final response, after metadata and cleanup receipts are added."""
    cap = policy.get("max_response_bytes", policy["max_characters"])
    while len(_encoded(response)) > cap and response.get("rows"):
        response["rows"].pop()
        response["truncated"] = True
    if len(_encoded(response)) > cap:
        response = {"ok": False, "error": "final response exceeds byte cap", "cleanup": response.get("cleanup")}
    return response

try:  # Package import for FastAPI/library consumers.
    from .contract import LoadedContract, load_contract
    from .policy import ValidatedQuery, validate_sql
except ImportError:  # Direct wrapper.py execution from the shipped directory.
    from contract import LoadedContract, load_contract
    from policy import ValidatedQuery, validate_sql


def preflight(contract_path: str, expected_hash: str, environment: Mapping[str, str] | None = None) -> LoadedContract:
    """Validate canonical contract/config only; this never opens DuckDB or an attachment."""
    return load_contract(contract_path, expected_hash, environment)


def _worker_environment(loaded: LoadedContract, temporary: str) -> dict[str, str]:
    # Do not forward ambient credentials. Keep only platform loader essentials,
    # fixed Python hardening flags, disposable temp paths, and declared replica bindings.
    environment: dict[str, str] = {}
    for name in ("SYSTEMROOT", "WINDIR", "COMSPEC", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    environment.update({
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONUTF8": "1",
        "TMP": temporary,
        "TEMP": temporary,
        "TMPDIR": temporary,
        "ALG_DUCKDB_PARENT_PID": str(os.getpid()),
    })
    for attachment in loaded.resolved_attachments:
        environment[attachment.source_env] = str(attachment.path)
    return environment


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> bool:
    """Terminate the process group/tree and confirm the root exited."""
    if process.poll() is not None:
        return True
    tree_signal_succeeded = False
    try:
        if os.name == "nt":
            system_root = os.environ.get("SYSTEMROOT") or os.environ.get("WINDIR")
            taskkill = str(Path(system_root, "System32", "taskkill.exe")) if system_root else "taskkill.exe"
            completed = subprocess.run(
                [taskkill, "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            tree_signal_succeeded = completed.returncode == 0
        else:
            os.killpg(process.pid, signal.SIGKILL)
            tree_signal_succeeded = True
    except (OSError, subprocess.SubprocessError):
        tree_signal_succeeded = False
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        return False
    return tree_signal_succeeded and process.poll() is not None


def _bounded_worker_response(stdout: bytes, loaded: LoadedContract) -> dict[str, Any]:
    policy = loaded.contract["policy"]
    byte_cap = max(policy["max_characters"], policy["max_diagnostic_characters"]) * 4 + 65_536
    if len(stdout) > byte_cap:
        return {"ok": False, "error": "query worker response exceeded byte cap"}
    try:
        response = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"ok": False, "error": "query worker returned invalid bounded output"}
    if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
        return {"ok": False, "error": "query worker returned an invalid response shape"}
    if response["ok"]:
        if len(json.dumps(response, ensure_ascii=False, separators=(",", ":"))) > policy["max_characters"]:
            return {"ok": False, "error": "query worker success response exceeded character cap"}
    else:
        error = response.get("error")
        if not isinstance(error, str):
            return {"ok": False, "error": "query worker returned an invalid diagnostic"}
        response = {"ok": False, "error": error[: policy["max_diagnostic_characters"]]}
    return response


def _run_worker(loaded: LoadedContract, operation: str, sql: str | None,
                cancel_event: threading.Event | None = None) -> dict[str, Any]:
    if not _ADMISSION.acquire(blocking=False):
        return {"ok": False, "error": "query capacity is busy", "busy": True}
    try:
        return _supervise_worker(loaded, operation, sql, cancel_event)
    finally:
        _ADMISSION.release()


def _supervise_worker(loaded: LoadedContract, operation: str, sql: str | None,
                      cancel_event: threading.Event | None) -> dict[str, Any]:
    temporary = tempfile.mkdtemp(prefix="alg-duckdb-query-")
    request = {
        "operation": operation,
        "contract_path": str(loaded.path),
        "expected_hash": loaded.sha256,
        "temporary_directory": temporary,
        "sql": sql,
    }
    worker = str(Path(__file__).with_name("worker.py").resolve())
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
    process: subprocess.Popen[bytes] | None = None
    job: _WindowsJob | None = None
    response: dict[str, Any] = {"ok": False, "error": "query worker failed"}
    reader: threading.Thread | None = None
    writer: threading.Thread | None = None
    output: list[bytes] = []
    read_done = threading.Event()
    io_failed = threading.Event()
    byte_cap = loaded.contract["policy"].get("max_response_bytes", loaded.contract["policy"]["max_characters"])
    deadline = time.monotonic() + loaded.contract["policy"]["timeout_ms"] / 1000
    try:
        request_bytes = _encoded(request)
        if len(request_bytes) > 256 * 1024:
            raise ValueError("worker request exceeds byte cap")
        process = subprocess.Popen(
            [sys.executable, "-B", "-I", worker],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=temporary,
            env=_worker_environment(loaded, temporary),
            start_new_session=os.name != "nt",
            creationflags=creationflags | getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if os.name == "nt":
            job = _WindowsJob(process)
        def read_output() -> None:
            try:
                output.append(process.stdout.read(byte_cap + 1))
            except (OSError, ValueError):
                io_failed.set()
            finally:
                read_done.set()
        def write_input() -> None:
            try:
                process.stdin.write(request_bytes)
            except (OSError, ValueError):
                io_failed.set()
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    io_failed.set()
        reader = threading.Thread(target=read_output, daemon=True)
        writer = threading.Thread(target=write_input, daemon=True)
        reader.start()
        writer.start()
        while True:
            timed_out = time.monotonic() >= deadline
            cancelled = cancel_event is not None and cancel_event.is_set()
            overflow = bool(output) and len(output[0]) > byte_cap
            if timed_out or cancelled or overflow:
                tree_cancelled = _terminate_process_tree(process)
                response = {"ok": False, "error": "query cancelled" if cancelled else "query timed out" if timed_out else "worker output exceeded byte cap",
                            "timed_out": timed_out, "cancelled": process.poll() is not None,
                            "process_tree_cancelled": tree_cancelled}
                break
            if read_done.is_set() and process.poll() is not None:
                response = _bounded_worker_response(output[0] if output else b"", loaded) if process.returncode == 0 and not io_failed.is_set() else response
                break
            time.sleep(0.02)
    except (OSError, ValueError, subprocess.SubprocessError):
        response = {"ok": False, "error": "query worker transport failed"}
    finally:
        if job is not None:
            job.close()
        if process is not None and process.poll() is None:
            _terminate_process_tree(process)
        if reader is not None:
            reader.join(timeout=1)
        if writer is not None:
            writer.join(timeout=1)
        if process is not None:
            for stream in (process.stdin, process.stdout):
                if stream is not None and not stream.closed and (reader is None or not reader.is_alive()) and (writer is None or not writer.is_alive()):
                    stream.close()
        removed = False
        try:
            shutil.rmtree(temporary)
            removed = not Path(temporary).exists()
        except OSError:
            pass
        response["cleanup"] = {"worker_exited": process is None or process.poll() is not None,
                               "temporary_removed": removed}
        if not all(response["cleanup"].values()):
            response["ok"] = False
            response["error"] = "query cleanup incomplete"
    return bound_response(response, loaded.contract["policy"])


def compatibility(contract_path: str, expected_hash: str) -> dict[str, Any]:
    """Verify engine/parser/settings/attachments in a disposable process."""
    loaded = load_contract(contract_path, expected_hash)
    return _run_worker(loaded, "compatibility", None)


def query(contract_path: str, expected_hash: str, sql: str,
          cancel_event: threading.Event | None = None) -> dict[str, Any]:
    loaded = load_contract(contract_path, expected_hash)
    validated: ValidatedQuery = validate_sql(sql, loaded.contract["policy"])
    response = _run_worker(loaded, "query", validated.sql, cancel_event)
    response.update({
        "executing": validated.executing,
        "explain": validated.explain,
        "analyze": validated.analyze,
        "statement_class": validated.statement_class,
        "relations": list(validated.relations),
        "contract_sha256": loaded.sha256,
    })
    return bound_response(response, loaded.contract["policy"])
