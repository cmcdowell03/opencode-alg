"""Explicit bounded subprocess CLI. Use a prepared interpreter; never resolves dependencies."""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import tempfile
import shutil
import signal
from pathlib import Path

OUTPUT_CAP = 128 * 1024


class WindowsJob:
    """Kill-on-owner-exit containment, independent of the SQL capability."""
    def __init__(self, process):
        import ctypes
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [("pt", ctypes.c_int64), ("jt", ctypes.c_int64), ("flags", wintypes.DWORD),
                        ("min", ctypes.c_size_t), ("max", ctypes.c_size_t), ("active", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("r", "w", "o", "rb", "wb", "ob")]
        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("pm", ctypes.c_size_t), ("jm", ctypes.c_size_t), ("pp", ctypes.c_size_t), ("pj", ctypes.c_size_t)]
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        self.api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("worker ownership failed")
        limits = Extended()
        limits.basic.flags = 0x2000
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            self.close()
            raise OSError("worker ownership failed")

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


def encode(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("nonfinite JSON")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def supervise(project, raw, catalog=False, timeout=30):
    if len(raw) > (8 * 1024 * 1024 if catalog else 65536):
        return {"ok": False, "error": "request exceeds bound"}
    temporary = tempfile.mkdtemp(prefix="alg-ds-worker-")
    process = job = None
    threads, output = [], []
    done, io_error = threading.Event(), threading.Event()
    result = {"ok": False, "error": "data-science worker failed"}
    deadline = time.monotonic() + timeout
    try:
        environment = {name: os.environ[name] for name in ("SYSTEMROOT", "WINDIR") if name in os.environ}
        environment.update({"TEMP": temporary, "TMP": temporary, "TMPDIR": temporary, "ALG_DS_PARENT_PID": str(os.getpid())})
        command = [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--internal-worker", "--project", project]
        if catalog:
            command.append("--catalog-worker")
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   cwd=temporary, env=environment, start_new_session=os.name != "nt",
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if os.name == "nt":
            job = WindowsJob(process)
        def write():
            try:
                process.stdin.write(raw)
                process.stdin.close()
            except (OSError, ValueError):
                io_error.set()
        def read():
            try:
                output.append(process.stdout.read(OUTPUT_CAP + 1))
            except (OSError, ValueError):
                io_error.set()
            finally:
                done.set()
        threads = [threading.Thread(target=write, daemon=True), threading.Thread(target=read, daemon=True)]
        for thread in threads:
            thread.start()
        while True:
            if output and len(output[0]) > OUTPUT_CAP:
                result = {"ok": False, "error": "worker output exceeds bound"}
                break
            if time.monotonic() >= deadline:
                result = {"ok": False, "error": "data-science deadline exceeded", "timed_out": True}
                break
            if done.is_set() and process.poll() is not None:
                if not io_error.is_set() and output:
                    candidate = decode(output[0])
                    if isinstance(candidate, dict) and type(candidate.get("ok")) is bool and process.returncode in (0, 1) and candidate["ok"] == (process.returncode == 0):
                        result = candidate
                break
            time.sleep(0.02)
    except Exception:
        result = {"ok": False, "error": "data-science worker failed"}
    finally:
        if job:
            job.close()
        if process and process.poll() is None:
            try:
                if os.name != "nt":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait(timeout=2)
            except (OSError, subprocess.SubprocessError):
                pass
        for thread in threads:
            thread.join(timeout=1)
        if process and not any(thread.is_alive() for thread in threads):
            for stream in (process.stdin, process.stdout):
                stream.close()
        removed = False
        # Job termination can precede descendant handle teardown on Windows.
        for attempt in range(10):
            try:
                shutil.rmtree(temporary)
                removed = not Path(temporary).exists()
                break
            except FileNotFoundError:
                removed = True
                break
            except OSError:
                if attempt < 9:
                    time.sleep(0.05)
        result["cleanup"] = {"worker_exited": process is None or process.poll() is not None, "temporary_removed": removed}
        if not all(result["cleanup"].values()):
            result = {"ok": False, "error": "data-science cleanup incomplete", "cleanup": result["cleanup"]}
    if len(encode(result)) > OUTPUT_CAP:
        result = {"ok": False, "error": "final response exceeds bound", "cleanup": result["cleanup"]}
    return result


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("invalid CLI arguments")

def main() -> int:
    parser = SafeParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--request")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--catalog-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--internal-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker or args.catalog_worker or args.internal_worker:
        try:
            cap = 8 * 1024 * 1024 if args.catalog_worker else 65536
            raw = sys.stdin.buffer.read(cap + 1)
            if len(raw) > cap:
                raise ValueError("request too large")
            if not args.internal_worker:
                result = supervise(args.project, raw, args.catalog_worker)
                sys.stdout.buffer.write(encode(result))
                return 0 if result["ok"] else 1
            parent = int(os.environ.get("ALG_DS_PARENT_PID", "0"))
            if parent <= 1 or os.name != "nt" and os.getppid() != parent:
                raise ValueError("invalid worker ownership")
            if os.name != "nt":
                def watch():
                    while os.getppid() == parent:
                        time.sleep(0.1)
                    os._exit(1)
                threading.Thread(target=watch, daemon=True).start()
            request = decode(raw)
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            if args.catalog_worker:
                from catalog import rebuild_catalog
                result = {"ok": True, **rebuild_catalog(args.project, request)}
            else:
                from operations import run_operation
                result = run_operation(args.project, request)
            output = json.dumps(result, ensure_ascii=False, allow_nan=False)
            if len(output.encode("utf-8")) > 128 * 1024:
                raise ValueError("response too large")
            print(output)
            return 0 if result["ok"] else 1
        except Exception as error:
            # Arrow diagnostics may contain data values; never expose their text.
            print(json.dumps({"ok": False, "error": "data-science request rejected", "error_class": type(error).__name__}))
            return 1
    if not args.request:
        parser.error("--request is required")
    request_path = Path(args.request)
    if not request_path.is_absolute() or request_path.is_symlink() or not request_path.is_file() or request_path.stat().st_size > 65536:
        parser.error("--request must be a bounded absolute JSON file")
    with request_path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(65537)
        after = os.fstat(stream.fileno())
    current = request_path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if identity(before) != identity(after) or identity(before) != identity(current) or request_path.is_symlink():
        raise ValueError("request changed")
    if len(raw) > 65536:
        parser.error("request grew beyond bound")
    # No ambient cloud/DB credentials are forwarded to this local-only capability.
    result = supervise(args.project, raw)
    sys.stdout.buffer.write(encode(result))
    return 0 if result["ok"] else 1

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stdout.buffer.write(encode({"ok": False, "error": "data-science request rejected"}))
        raise SystemExit(1)
