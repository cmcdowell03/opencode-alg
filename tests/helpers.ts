import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { GraphDef } from "../src/types.ts"

export function tempProject(label = "alg-test-"): string {
  return mkdtempSync(join(tmpdir(), label))
}

export function removeProject(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export function singleImplementGraph(options?: {
  maxAttempts?: number
  maxGlobal?: number
}): GraphDef {
  const maxAttempts = options?.maxAttempts ?? 1
  return {
    name: "test-graph",
    max_global_attempts: options?.maxGlobal ?? maxAttempts,
    max_concurrency: 2,
    nodes: [
      {
        id: "work",
        agent: "implementer",
        depends_on: [],
        loop: { max_attempts: maxAttempts, gate: "schema" },
      },
    ],
  }
}

export function inertClient(): never {
  return {
    session: {
      create: async () => {
        throw new Error("unexpected SDK call")
      },
      prompt: async () => {
        throw new Error("unexpected SDK call")
      },
    },
    app: { log: async () => ({ data: true, error: undefined }) },
  } as never
}

export function executeContext(project: string, signal = new AbortController().signal) {
  return {
    client: inertClient(),
    parentSessionId: "session-owner",
    directory: project,
    worktree: project,
    toolContext: {
      ask: async () => {},
      abort: signal,
    },
  }
}
