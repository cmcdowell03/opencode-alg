import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertRunArtifactPathContained,
  createRun,
  linkSession,
  loadRun,
  persistRun,
  runDir,
} from "../src/store.ts"
import { getTemplate } from "../src/templates.ts"
import { executeRun } from "../src/executor.ts"
import { loadModelSettings, modelSettingsPath } from "../src/models.ts"
import {
  isContained,
  canonicalDirectory,
  resolveContainedPath,
  resolveContainedPathWithOperations,
  type ContainmentFilesystemOperations,
} from "../src/paths.ts"
import { runInstaller } from "../scripts/installer-core.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function unavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "UNKNOWN"
}

function directoryLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir")
    return true
  } catch (error) {
    if (unavailable(error)) return false
    throw error
  }
}

function removeDirectoryLink(path: string): void {
  if (process.platform === "win32") {
    rmdirSync(path)
    return
  }
  unlinkSync(path)
}

function fileLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file")
    return true
  } catch (error) {
    if (unavailable(error)) return false
    throw error
  }
}

function linkAvailable(kind: "directory" | "file"): boolean {
  const root = tempProject(`alg-${kind}-link-probe-`)
  const target = tempProject(`alg-${kind}-link-target-`)
  try {
    if (kind === "file") {
      const targetFile = join(target, "target.txt")
      writeFileSync(targetFile, "probe", "utf8")
      return fileLink(targetFile, join(root, "link.txt"))
    }
    return directoryLink(target, join(root, "link"))
  } finally {
    removeProject(root)
    removeProject(target)
  }
}

const directoryLinkTest = linkAvailable("directory") ? test : test.skip
const fileLinkTest = linkAvailable("file") ? test : test.skip

describe("existing-component realpath containment", () => {
  test("injectable strict absence proof covers $Deleted, disappearance, denial, and symlink branches", () => {
    const root = process.platform === "win32" ? "C:\\trusted" : "/trusted"
    const component = resolve(root, "component")
    const outside = process.platform === "win32"
      ? "C:\\$Extend\\$Deleted\\escaped"
      : "/outside/escaped"
    const missing = (code: "ENOENT" | "ENOTDIR") => Object.assign(new Error(code), { code })
    const denied = (code: "EPERM" | "EACCES") => Object.assign(new Error(code), { code })

    const operations = (options: {
      realpathResult?: string
      realpathError?: unknown
      secondLstatError?: unknown
    }): ContainmentFilesystemOperations => {
      let componentLstats = 0
      return {
        lstat(path) {
          if (path !== component) return {}
          componentLstats++
          if (componentLstats >= 2 && options.secondLstatError) throw options.secondLstatError
          return {}
        },
        realpath(path) {
          if (path === root) return root
          if (options.realpathError) throw options.realpathError
          return options.realpathResult ?? path
        },
      }
    }

    expect(resolveContainedPathWithOperations(root, ["component", "future"], operations({
      realpathResult: outside,
      secondLstatError: missing("ENOENT"),
    }))).toBe(resolve(root, "component", "future"))

    expect(() => resolveContainedPathWithOperations(root, ["component"], operations({
      realpathResult: outside,
    }))).toThrow(/existing path component escapes/)

    for (const code of ["EPERM", "EACCES"] as const) {
      expect(() => resolveContainedPathWithOperations(root, ["component"], operations({
        realpathResult: outside,
        secondLstatError: denied(code),
      }))).toThrow(code)
    }

    expect(resolveContainedPathWithOperations(root, ["component", "future"], operations({
      realpathError: missing("ENOENT"),
      secondLstatError: missing("ENOTDIR"),
    }))).toBe(resolve(root, "component", "future"))

    expect(() => resolveContainedPathWithOperations(root, ["component"], operations({
      realpathResult: outside,
    }))).toThrow(/existing path component escapes/)
  })

  directoryLinkTest("rejects .opencode, runs, and run-directory symlink/junction escapes", () => {
    const projects: string[] = []
    const outside = tempProject("alg-outside-")
    try {
      const opencodeProject = tempProject()
      projects.push(opencodeProject)
      directoryLink(outside, join(opencodeProject, ".opencode"))
      expect(() => createRun({
        goal: "escape",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: opencodeProject,
        ownerSessionId: "owner",
      })).toThrow(/existing path component escapes/)
      expect(() => modelSettingsPath(opencodeProject)).toThrow(/existing path component escapes/)

      const runsProject = tempProject()
      projects.push(runsProject)
      mkdirSync(join(runsProject, ".opencode"))
      directoryLink(outside, join(runsProject, ".opencode", "runs"))
      expect(() => runDir(runsProject, "safe-run")).toThrow(/existing path component escapes/)

      const runProject = tempProject()
      projects.push(runProject)
      mkdirSync(join(runProject, ".opencode", "runs"), { recursive: true })
      directoryLink(outside, join(runProject, ".opencode", "runs", "safe-run"))
      expect(() => runDir(runProject, "safe-run")).toThrow(/existing path component escapes/)
    } finally {
      for (const project of projects) removeProject(project)
      removeProject(outside)
    }
  }, 15_000)

  fileLinkTest("rejects a model file symlink escape", () => {
    const project = tempProject()
    const outside = tempProject("alg-outside-file-")
    try {
      mkdirSync(join(project, ".opencode"))
      const externalModel = join(outside, "model.json")
      writeFileSync(externalModel, '{"outside":true}', "utf8")
      fileLink(externalModel, join(project, ".opencode", "alg-models.json"))
      expect(() => loadModelSettings(project)).toThrow(/existing path component escapes/)
    } finally {
      removeProject(project)
      removeProject(outside)
    }
  }, 15_000)

  fileLinkTest("rejects a config file symlink escape without touching its target", () => {
    const outside = tempProject("alg-outside-config-file-")
    const configRoot = tempProject("alg-config-link-")
    try {
      const externalConfig = join(outside, "opencode.jsonc")
      const original = '{ "plugin": ["outside"] }\n'
      writeFileSync(externalConfig, original, "utf8")
      fileLink(externalConfig, join(configRoot, "opencode.jsonc"))
      expect(() => runInstaller({ root: ROOT, configDir: configRoot, skipAgents: true }))
        .toThrow(/existing path component escapes/)
      expect(readFileSync(externalConfig, "utf8")).toBe(original)
    } finally {
      removeProject(configRoot)
      removeProject(outside)
    }
  }, 15_000)

  directoryLinkTest("rejects a config agent-directory junction escape", () => {
    const outside = tempProject("alg-outside-config-agents-")
    const configRoot = tempProject("alg-config-junction-")
    const sentinel = join(outside, "sentinel.txt")
    try {
      writeFileSync(sentinel, "keep", "utf8")
      directoryLink(outside, join(configRoot, "agents"))
      expect(() => runInstaller({ root: ROOT, configDir: configRoot }))
        .toThrow(/existing path component escapes/)
      expect(readFileSync(sentinel, "utf8")).toBe("keep")
    } finally {
      removeProject(configRoot)
      removeProject(outside)
    }
  }, 15_000)

  test("safely resolves not-yet-created paths below a canonical root", () => {
    const project = tempProject()
    try {
      const future = resolveContainedPath(project, ".opencode", "runs", "future-run", "progress.json")
      expect(isContained(canonicalDirectory(project), future)).toBe(true)
    } finally {
      removeProject(project)
    }
  })

  directoryLinkTest("rejects escaping artifacts/checks/sessions and nested junctions without touching outside", async () => {
    const outside = tempProject("alg-nested-outside-")
    const projects: string[] = []
    const sentinel = join(outside, "sentinel.txt")
    writeFileSync(sentinel, "keep", "utf8")
    const unchanged = () => ({
      names: readdirSync(outside).sort(),
      sentinel: readFileSync(sentinel, "utf8"),
    })
    const before = unchanged()
    try {
      const artifactProject = tempProject()
      projects.push(artifactProject)
      const artifactRun = createRun({
        goal: "artifact junction",
        criteria: [],
        graph: getTemplate("coding-diamond"),
        projectDirectory: artifactProject,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      await executeRun(artifactRun, { ...executeContext(artifactProject), dry: true })
      const artifactDirectory = join(runDir(artifactProject, artifactRun.run_id), "artifacts")
      rmSync(artifactDirectory, { recursive: true, force: true })
      directoryLink(outside, artifactDirectory)
      artifactRun.criteria = ["candidate"]
      expect(() => persistRun(artifactRun, artifactProject)).toThrow(/existing path component escapes/)
      expect(() => loadRun(artifactProject, artifactRun.run_id)).toThrow(/derived-file reconciliation failed/)
      expect(unchanged()).toEqual(before)

      const checksProject = tempProject()
      projects.push(checksProject)
      const checksRun = createRun({
        goal: "checks junction",
        criteria: [],
        graph: getTemplate("coding-diamond"),
        projectDirectory: checksProject,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      await executeRun(checksRun, { ...executeContext(checksProject), dry: true })
      const checksDirectory = join(runDir(checksProject, checksRun.run_id), "checks")
      rmSync(checksDirectory, { recursive: true, force: true })
      directoryLink(outside, checksDirectory)
      checksRun.criteria = ["candidate"]
      expect(() => persistRun(checksRun, checksProject)).toThrow(/existing path component escapes/)
      expect(unchanged()).toEqual(before)

      const sessionsProject = tempProject()
      projects.push(sessionsProject)
      const sessionsRun = createRun({
        goal: "sessions junction",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: sessionsProject,
        ownerSessionId: "owner",
      })
      const sessionsDirectory = join(runDir(sessionsProject, sessionsRun.run_id), "sessions")
      rmSync(sessionsDirectory, { recursive: true, force: true })
      directoryLink(outside, sessionsDirectory)
      expect(() => linkSession(sessionsRun, sessionsProject, "explore_a", 1, "child"))
        .toThrow(/existing path component escapes/)
      expect(unchanged()).toEqual(before)

      const nestedProject = tempProject()
      projects.push(nestedProject)
      const nestedRun = createRun({
        goal: "nested junction",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: nestedProject,
        ownerSessionId: "owner",
      })
      directoryLink(outside, join(runDir(nestedProject, nestedRun.run_id), "artifacts", "escape"))
      expect(() => loadRun(nestedProject, nestedRun.run_id)).toThrow(/derived-file reconciliation failed/)
      expect(unchanged()).toEqual(before)
    } finally {
      for (const project of projects) removeProject(project)
      removeProject(outside)
    }
  // Multiple junction containment cases cross fenced durable saves; retain
  // every outside-sentinel assertion with Windows filesystem I/O headroom.
  }, 120_000)

  directoryLinkTest("executor, persistence, and load reject artifact metadata through a nested junction", async () => {
    const outside = tempProject("alg-artifact-metadata-outside-")
    const projects: string[] = []
    const sentinel = join(outside, "sentinel.txt")
    writeFileSync(sentinel, "keep", "utf8")
    try {
      const persistProject = tempProject()
      projects.push(persistProject)
      const persisted = createRun({
        goal: "artifact metadata persist",
        criteria: [],
        graph: {
          name: "artifact-metadata",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: persistProject,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      const completed = await executeRun(persisted, { ...executeContext(persistProject), dry: true })
      const nested = join(runDir(persistProject, completed.run_id), "artifacts", "escape")
      directoryLink(outside, nested)
      const artifactPath = `.opencode/runs/${completed.run_id}/artifacts/escape/evidence.md`
      ;(completed.nodes.work!.output as any).artifact_path = artifactPath
      ;(completed.nodes.work!.attempts.at(-1)!.output as any).artifact_path = artifactPath
      expect(() => persistRun(completed, persistProject)).toThrow(/must resolve within.*artifacts/)

      writeFileSync(
        join(runDir(persistProject, completed.run_id), "progress.json"),
        `${JSON.stringify(completed, null, 2)}\n`,
        "utf8",
      )
      expect(() => loadRun(persistProject, completed.run_id)).toThrow(/corrupt or incompatible/)

      const executeProject = tempProject()
      projects.push(executeProject)
      const executing = createRun({
        goal: "artifact metadata execute",
        criteria: [],
        graph: {
          name: "artifact-metadata",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: executeProject,
        ownerSessionId: "session-owner",
      })
      const executeNested = join(runDir(executeProject, executing.run_id), "artifacts", "escape")
      directoryLink(outside, executeNested)
      const executeArtifactPath = `.opencode/runs/${executing.run_id}/artifacts/escape/evidence.md`
      expect(() => assertRunArtifactPathContained(
        executeProject,
        executing.run_id,
        executeArtifactPath,
      )).toThrow(/must resolve within.*artifacts/)
      removeDirectoryLink(executeNested)
      await expect(executeRun(executing, {
        ...executeContext(executeProject),
        sessionRunner: async () => {
          directoryLink(outside, executeNested)
          return {
            session_id: "child",
            text: "",
            parsed: {
              summary: ["forged"],
              files_touched: [],
              commands_run: [],
              risks: [],
              done: true,
              artifact_path: executeArtifactPath,
            },
          }
        },
      })).rejects.toThrow(/existing path component escapes/)
      expect(readFileSync(sentinel, "utf8")).toBe("keep")
      expect(readdirSync(outside)).toEqual(["sentinel.txt"])
    } finally {
      for (const project of projects) removeProject(project)
      removeProject(outside)
    }
  }, 60_000)

  directoryLinkTest("executor, persistence, and load reject files_touched through a project junction", async () => {
    const outside = tempProject("alg-files-metadata-outside-")
    const projects: string[] = []
    try {
      const persistProject = tempProject()
      projects.push(persistProject)
      const run = createRun({
        goal: "files metadata persist",
        criteria: [],
        graph: {
          name: "files-metadata",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: persistProject,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      const completed = await executeRun(run, { ...executeContext(persistProject), dry: true })
      directoryLink(outside, join(persistProject, "escape"))
      ;(completed.nodes.work!.output as any).files_touched = ["escape/outside.txt"]
      ;(completed.nodes.work!.attempts.at(-1)!.output as any).files_touched = ["escape/outside.txt"]
      expect(() => persistRun(completed, persistProject)).toThrow(/files_touched path must resolve within/)
      writeFileSync(
        join(runDir(persistProject, completed.run_id), "progress.json"),
        `${JSON.stringify(completed, null, 2)}\n`,
        "utf8",
      )
      expect(() => loadRun(persistProject, completed.run_id)).toThrow(/corrupt or incompatible/)

      const executeProject = tempProject()
      projects.push(executeProject)
      directoryLink(outside, join(executeProject, "escape"))
      const executing = createRun({
        goal: "files metadata execute",
        criteria: [],
        graph: {
          name: "files-metadata",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: executeProject,
        ownerSessionId: "session-owner",
      })
      const executed = await executeRun(executing, {
        ...executeContext(executeProject),
        sessionRunner: async () => ({
          session_id: "child",
          text: "",
          parsed: {
            summary: ["forged"],
            files_touched: ["escape/outside.txt"],
            commands_run: [],
            risks: [],
            done: true,
          },
        }),
      })
      expect(executed.status).toBe("failed")
      expect(executed.nodes.work!.last_failures.join(" ")).toContain("files_touched path must resolve within")
      expect(readdirSync(outside)).toEqual([])
    } finally {
      for (const project of projects) removeProject(project)
      removeProject(outside)
    }
  }, 60_000)
})
