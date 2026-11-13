import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { trackBenchmarkProcess } from "../scripts/build-benchmark.ts"
import { stopCapturedProcess } from "../scripts/live-verify.ts"

test("signal exit qualifies root cleanup even while inherited stdout stays open", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: "SIGTERM", pid: 101, kill: () => { throw Error("must not signal an exited root") } })
  const tracked = trackBenchmarkProcess(child as unknown as ChildProcess)
  expect(tracked.exit().observed).toBe(false)
  child.emit("exit", null, "SIGTERM")
  expect(child.stdout.destroyed).toBe(false)
  expect(tracked.exit()).toEqual({ observed: true, code: null, signal: "SIGTERM" })
  const receipt = await stopCapturedProcess(tracked, { platform: "win32", terminateTree: async () => { throw Error("must not target a recycled PID") } })
  expect(receipt.passed).toBe(true)
  expect(receipt.termination_result).toBe("already-exited")
  expect(receipt.cleanup_scope).toBe("root-process")
  expect(receipt.tree_termination_attempted).toBe(false)
  child.stdout.destroy(); child.stderr.destroy()
})

test("an open stream or output alone never manufactures root exit", () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null })
  const tracked = trackBenchmarkProcess(child as unknown as ChildProcess)
  child.stdout.write("still running");child.stderr.write("diagnostic")
  expect(tracked.exit().observed).toBe(false)
  expect(tracked.stdout()).toBe("still running")
  child.emit("exit", 2, null)
  expect(tracked.exit().code).toBe(2)
  child.stdout.destroy();child.stderr.destroy()
})
