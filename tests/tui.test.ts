import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import tuiModule from "../src/tui.ts"
import serverModule from "../src/server.ts"
import { modelCatalog, openAlgModels, tui } from "../src/tui-models.ts"
import { removeProject, tempProject } from "./helpers.ts"
import { parseAlgToolIds } from "../scripts/live-verify.ts"

const sandboxes: string[] = []
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function sandbox(): string {
  const path = tempProject("alg-tui-")
  sandboxes.push(path)
  return path
}

function provider(id: string, models: Array<{ id: string; name?: string; status?: string }>): any {
  return {
    id,
    name: id.toUpperCase(),
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, {
      id: model.id,
      providerID: id,
      name: model.name ?? model.id,
      status: model.status ?? "active",
    }])),
  }
}

function deepMerge(target: any, patch: any): any {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] ?? {}, value)
    } else target[key] = value
  }
  return target
}

function mockApi(options: {
  configDir?: string
  config?: any
  providers?: any[]
  updateError?: unknown
  getError?: unknown
} = {}) {
  const config = structuredClone(options.config ?? {})
  const dialogs: any[] = []
  const toasts: any[] = []
  const layers: any[] = []
  const updates: any[] = []
  const logs: any[] = []
  const events: string[] = []
  const configDir = options.configDir ?? sandbox()
  const api: any = {
    keymap: {
      registerLayer(layer: any) {
        events.push("register")
        layers.push(layer)
        return () => {}
      },
    },
    state: {
      provider: options.providers ?? [],
      path: { config: configDir },
    },
    client: {
      app: {
        async log(input: any) {
          events.push("log")
          logs.push(structuredClone(input))
          return { data: true, error: undefined }
        },
      },
      global: {
        config: {
          async get() {
            return options.getError
              ? { data: undefined, error: options.getError }
              : { data: structuredClone(config), error: undefined }
          },
          async update(input: any) {
            updates.push(structuredClone(input))
            if (options.updateError) return { data: undefined, error: options.updateError }
            deepMerge(config, input.config)
            return { data: structuredClone(config), error: undefined }
          },
        },
      },
    },
    ui: {
      DialogSelect(props: any) {
        dialogs.push(props)
        return {} as never
      },
      toast(input: any) {
        toasts.push(input)
      },
      dialog: {
        size: "medium",
        depth: 0,
        open: false,
        setSize() {},
        replace(render: () => unknown) {
          render()
        },
        clear() {},
      },
    },
  }
  return { api, config, dialogs, toasts, layers, updates, logs, events, configDir }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Bun.sleep(5)
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) removeProject(path)
})

describe("OpenCode 1.18.3 ALG TUI model picker", () => {
  test("live verifier parses only ALG IDs from raw endpoint response shapes", () => {
    expect(parseAlgToolIds('["read","alg_plan","alg_run"]')).toEqual(["alg_plan", "alg_run"])
    expect(parseAlgToolIds('{"tools":["alg_status",3,"write"]}')).toEqual(["alg_status"])
    expect(parseAlgToolIds("not-json")).toEqual([])
  })

  test("uses separate server and TUI modules and discovers ALG /alg-models through keymap", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    expect(pkg.exports["./server"]).toBe("./src/server.ts")
    expect(pkg.exports["./tui"]).toBe("./src/tui.ts")
    expect(pkg.opencode).toEqual({ server: "./src/server.ts", tui: "./src/tui.ts" })
    expect(tuiModule.id).toBe("opencode-alg")
    expect(typeof tuiModule.tui).toBe("function")
    expect("server" in tuiModule).toBe(false)
    expect(typeof serverModule.server).toBe("function")
    expect("tui" in serverModule).toBe(false)

    const mock = mockApi()
    await tui(mock.api, undefined, {} as never)
    expect(mock.layers).toHaveLength(1)
    expect(mock.events.slice(0, 2)).toEqual(["register", "log"])
    expect(mock.logs).toHaveLength(1)
    expect(mock.logs[0]).toMatchObject({
      service: "opencode-alg",
      level: "info",
      message: expect.stringContaining("/alg-models"),
    })
    const command = mock.layers[0].commands[0]
    expect(command).toMatchObject({
      name: "alg.models",
      title: "Choose agent models",
      category: "ALG",
      namespace: "palette",
      slashName: "alg-models",
    })
    await command.run()
    expect(mock.dialogs[0].options.map((item: any) => item.value)).toEqual([
      "explorer",
      "researcher",
      "implementer",
      "checker",
    ])
  })

  test("all four roles open a searchable picker and display current global selection", async () => {
    const config = {
      agent: {
        explorer: { model: "p/explore" },
        researcher: { model: "p/research" },
        implementer: { model: "p/implement" },
        checker: { model: "p/check" },
      },
    }
    const mock = mockApi({ config, providers: [provider("p", [{ id: "model" }])] })
    for (const role of ["explorer", "researcher", "implementer", "checker"]) {
      await openAlgModels(mock.api)
      const roleDialog = mock.dialogs.at(-1)
      expect(roleDialog.options.find((item: any) => item.value === role).description).toContain(config.agent[role as keyof typeof config.agent].model)
      roleDialog.onSelect(roleDialog.options.find((item: any) => item.value === role))
      const modelDialog = mock.dialogs.at(-1)
      expect(modelDialog.title).toContain(config.agent[role as keyof typeof config.agent].model)
      expect(modelDialog.placeholder).toContain("Search")
      expect(modelDialog.current).toBe(config.agent[role as keyof typeof config.agent].model)
    }
  })

  test("catalog uses connected providers, excludes deprecated models, and includes inherit", async () => {
    const providers = [
      provider("alpha", [
        { id: "good", name: "Good" },
        { id: "old", name: "Old", status: "deprecated" },
      ]),
      provider("beta", [{ id: "beta-model" }]),
    ]
    expect(modelCatalog(providers as never).map((item) => item.value)).toEqual([
      "alpha/good",
      "beta/beta-model",
    ])
    const mock = mockApi({ providers })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options[0])
    const choices = mock.dialogs.at(-1).options
    expect(choices[0].value).toBeNull()
    expect(choices[0].title).toBe("Inherit OpenCode default")
    expect(choices.map((item: any) => item.value)).not.toContain("alpha/old")
  })

  test("saves one global role through the official API without changing other config", async () => {
    const mock = mockApi({
      config: {
        username: "keep-me",
        provider: { custom: { options: { keep: true } } },
        agent: {
          explorer: { model: "old/explorer", description: "keep" },
          checker: { model: "old/checker" },
        },
      },
      providers: [provider("new", [{ id: "implementer-model" }])],
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "implementer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "new/implementer-model"))
    await settle()

    expect(mock.updates).toEqual([{ config: { agent: { implementer: { model: "new/implementer-model" } } } }])
    expect(mock.config.username).toBe("keep-me")
    expect(mock.config.provider.custom.options.keep).toBe(true)
    expect(mock.config.agent.explorer).toEqual({ model: "old/explorer", description: "keep" })
    expect(mock.config.agent.checker.model).toBe("old/checker")
    expect(mock.config.agent.implementer.model).toBe("new/implementer-model")
    expect(mock.toasts.at(-1)).toMatchObject({ variant: "success", title: "ALG models saved" })
    expect(mock.toasts.at(-1).message).toContain("restart OpenCode")
  })

  test("inherit structurally clears only that role and creates an exact backup", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const before = `{
  // preserve this comment
  "username": "keep",
  "agent": {
    "explorer": { "model": "old/explorer", "description": "keep description" },
    "checker": { "model": "old/checker" },
  },
}
`
    writeFileSync(file, before)
    const mock = mockApi({
      configDir,
      config: { agent: { explorer: { model: "old/explorer" }, checker: { model: "old/checker" } } },
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "explorer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === null))
    await settle()

    const after = readFileSync(file, "utf8")
    const data = parse(after) as any
    expect(after).toContain("// preserve this comment")
    expect(data.username).toBe("keep")
    expect(data.agent.explorer.model).toBeUndefined()
    expect(data.agent.explorer.description).toBe("keep description")
    expect(data.agent.checker.model).toBe("old/checker")
    const names = readdirSync(configDir).filter((name) => name.startsWith("opencode.jsonc.alg-backup-"))
    expect(names).toHaveLength(1)
    expect(readFileSync(join(configDir, names[0]!), "utf8")).toBe(before)
    expect(mock.toasts.at(-1).variant).toBe("success")
    expect(mock.toasts.at(-1).message).toContain("restart OpenCode")
  })

  test("save and global-read failures produce error toasts", async () => {
    const saveMock = mockApi({
      providers: [provider("p", [{ id: "m" }])],
      updateError: { message: "denied" },
    })
    await openAlgModels(saveMock.api)
    const roles = saveMock.dialogs.at(-1)
    roles.onSelect(roles.options[0])
    const models = saveMock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "p/m"))
    await settle()
    expect(saveMock.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG models not saved" })
    expect(saveMock.toasts.at(-1).message).toContain("denied")

    const readMock = mockApi({ getError: { message: "offline" } })
    await openAlgModels(readMock.api)
    expect(readMock.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG models unavailable" })
    expect(readMock.toasts.at(-1).message).toContain("offline")
  })
})
