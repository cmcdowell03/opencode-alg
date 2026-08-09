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

function provider(id: string, models: Array<{
  id: string
  name?: string
  status?: string
  variants?: Record<string, { disabled?: boolean }>
}>): any {
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
      variants: model.variants,
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
  /** Null simulates a response whose URL is unavailable. */
  responseUrl?: string | null
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
              ? { data: undefined, error: options.getError, response: { url: "" } }
              : {
                  data: structuredClone(config),
                  error: undefined,
                  response: {
                    url: options.responseUrl === undefined
                      ? "http://127.0.0.1:4096/global/config"
                      : options.responseUrl ?? "",
                  },
                }
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
        explorer: { model: "p/explore", variant: "deep" },
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
      expect(roleDialog.options.find((item: any) => item.value === role).description).toContain(
        role === "explorer" ? "deep" : "Default model effort",
      )
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
        {
          id: "good",
          name: "Good",
          variants: { zeta: {}, disabled: { disabled: true }, alpha: {} },
        },
        { id: "old", name: "Old", status: "deprecated" },
      ]),
      provider("beta", [{ id: "beta-model" }]),
    ]
    expect(modelCatalog(providers as never).map((item) => item.value)).toEqual([
      "alpha/good",
      "beta/beta-model",
    ])
    expect(modelCatalog(providers as never)[0]!.variants).toEqual(["alpha", "zeta"])
    const mock = mockApi({ providers })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options[0])
    const choices = mock.dialogs.at(-1).options
    expect(choices[0].value).toBeNull()
    expect(choices[0].title).toBe("Inherit OpenCode default")
    expect(choices.map((item: any) => item.value)).not.toContain("alpha/old")
  })

  test("a catalog model with variants opens a searchable second picker and patches exact effort", async () => {
    const mock = mockApi({
      config: { agent: { explorer: { model: "p/m", variant: "zeta" } } },
      responseUrl: "https://remote.example/global/config",
      providers: [provider("p", [{
        id: "m",
        variants: { zeta: {}, disabled: { disabled: true }, alpha: {} },
      }])],
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "explorer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "p/m"))

    expect(mock.updates).toEqual([])
    const efforts = mock.dialogs.at(-1)
    expect(efforts.placeholder).toContain("Search")
    expect(efforts.current).toBe("zeta")
    expect(efforts.options.map((item: any) => item.value)).toEqual([null, "alpha", "zeta"])
    expect(efforts.options[0].title).toBe("Default model effort")
    efforts.onSelect(efforts.options.find((item: any) => item.value === "alpha"))
    await settle()

    expect(mock.updates).toEqual([{
      config: { agent: { explorer: { model: "p/m", variant: "alpha" } } },
    }])
    expect(mock.toasts.at(-1)).toMatchObject({ variant: "success" })
    expect(mock.toasts.at(-1).message).toContain("alpha")
    expect(mock.toasts.at(-1).message).toContain("restart OpenCode")
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
      responseUrl: null,
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

  test("inherit structurally clears that role's model and variant in one plan and creates an exact backup", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const before = `{
  // preserve this comment
  "username": "keep",
  "agent": {
    "explorer": { "model": "old/explorer", "variant": "deep", "description": "keep description" },
    "checker": { "model": "old/checker" },
  },
}
`
    writeFileSync(file, before)
    const mock = mockApi({
      configDir,
      config: {
        agent: {
          explorer: { model: "old/explorer", variant: "deep" },
          checker: { model: "old/checker" },
        },
      },
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
    expect(data.agent.explorer.variant).toBeUndefined()
    expect(data.agent.explorer.description).toBe("keep description")
    expect(data.agent.checker.model).toBe("old/checker")
    const names = readdirSync(configDir).filter((name) => name.startsWith("opencode.jsonc.alg-backup-"))
    expect(names).toHaveLength(1)
    expect(readFileSync(join(configDir, names[0]!), "utf8")).toBe(before)
    expect(mock.updates).toEqual([])
    expect(mock.toasts.at(-1).variant).toBe("success")
    expect(mock.toasts.at(-1).message).toContain("restart OpenCode")
  })

  test("default effort atomically sets a changed model and deletes variant with BOM/comment/exact-backup preservation", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const text = `{
  // keep this comment
  "username": "keep",
  "agent": {
    "explorer": { "model": "p/old", "variant": "deep", "description": "keep" },
    "checker": { "model": "p/check", "variant": "other" },
  },
}
`
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
    writeFileSync(file, before)
    const mock = mockApi({
      configDir,
      config: { agent: { explorer: { model: "p/old", variant: "deep" } } },
      providers: [provider("p", [{ id: "new", variants: { deep: {}, light: {} } }])],
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "explorer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "p/new"))
    const efforts = mock.dialogs.at(-1)
    efforts.onSelect(efforts.options.find((item: any) => item.value === null))
    await settle()

    expect(mock.updates).toEqual([])
    const bytes = readFileSync(file)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const after = bytes.subarray(3).toString("utf8")
    const data = parse(after) as any
    expect(after).toContain("// keep this comment")
    expect(data.username).toBe("keep")
    expect(data.agent.explorer).toEqual({ model: "p/new", description: "keep" })
    expect(data.agent.checker).toEqual({ model: "p/check", variant: "other" })
    const backups = readdirSync(configDir).filter((name) => name.startsWith("opencode.jsonc.alg-backup-"))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(configDir, backups[0]!))).toEqual(before)
    expect(mock.toasts.at(-1).message).toContain("Default model effort")
  })

  test("non-loopback response rejects a stale exact-match local file without API call or write", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const before = `{"agent":{"explorer":{"model":"p/m","variant":"deep"}}}\n`
    writeFileSync(file, before)
    const defaultMock = mockApi({
      configDir,
      config: { agent: { explorer: { model: "p/m", variant: "deep" } } },
      providers: [provider("p", [{ id: "m", variants: { deep: {} } }])],
      responseUrl: "https://remote.example/global/config",
    })
    await openAlgModels(defaultMock.api)
    let dialog = defaultMock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "explorer"))
    dialog = defaultMock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "p/m"))
    dialog = defaultMock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === null))
    await settle()
    expect(defaultMock.updates).toEqual([])
    expect(defaultMock.toasts.at(-1)).toMatchObject({ variant: "error" })
    expect(defaultMock.toasts.at(-1).message).toContain("attached/remote")
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(readdirSync(configDir).filter((name) => name.includes("alg-backup"))).toEqual([])
  })

  test("unavailable URL, ambiguous sources, and mismatched local role values fail closed", async () => {
    const cases: Array<{
      name: string
      responseUrl?: string | null
      files: Record<string, string>
      message: string
    }> = [
      {
        name: "unavailable-url",
        responseUrl: null,
        files: { "opencode.jsonc": `{"agent":{"checker":{"model":"p/check","variant":"strict"}}}\n` },
        message: "response URL unavailable",
      },
      {
        name: "ambiguous",
        files: {
          "config.json": `{"agent":{"checker":{"model":"p/check","variant":"strict"}}}\n`,
          "opencode.jsonc": `{"agent":{"checker":{"model":"p/check","variant":"strict"}}}\n`,
        },
        message: "ambiguous or split",
      },
      {
        name: "mismatched",
        files: { "opencode.jsonc": `{"agent":{"checker":{"model":"p/other","variant":"strict"}}}\n` },
        message: "does not match",
      },
    ]
    for (const item of cases) {
      const configDir = sandbox()
      for (const [name, text] of Object.entries(item.files)) writeFileSync(join(configDir, name), text)
      const before = Object.fromEntries(Object.keys(item.files).map((name) => [name, readFileSync(join(configDir, name), "utf8")]))
      const mock = mockApi({
        configDir,
        config: { agent: { checker: { model: "p/check", variant: "strict" } } },
        responseUrl: item.responseUrl,
      })
      await openAlgModels(mock.api)
      let dialog = mock.dialogs.at(-1)
      dialog.onSelect(dialog.options.find((option: any) => option.value === "checker"))
      dialog = mock.dialogs.at(-1)
      dialog.onSelect(dialog.options.find((option: any) => option.value === null))
      await settle()
      expect(mock.updates, item.name).toEqual([])
      expect(mock.toasts.at(-1).message, item.name).toContain(item.message)
      expect(readdirSync(configDir).filter((name) => name.includes("alg-backup")), item.name).toEqual([])
      for (const [name, text] of Object.entries(before)) {
        expect(readFileSync(join(configDir, name), "utf8"), item.name).toBe(text)
      }
    }
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

  test("explicit-variant API failure leaves the local source untouched", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const before = `{"agent":{"explorer":{"model":"p/m","variant":"deep"}}}\n`
    writeFileSync(file, before)
    const mock = mockApi({
      configDir,
      config: { agent: { explorer: { model: "p/m", variant: "deep" } } },
      providers: [provider("p", [{ id: "m", variants: { deep: {}, light: {} } }])],
      updateError: { message: "write denied" },
    })
    await openAlgModels(mock.api)
    let dialog = mock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "explorer"))
    dialog = mock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "p/m"))
    dialog = mock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "light"))
    await settle()
    expect(mock.updates).toEqual([{
      config: { agent: { explorer: { model: "p/m", variant: "light" } } },
    }])
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(readdirSync(configDir).filter((name) => name.includes("alg-backup"))).toEqual([])
    expect(mock.toasts.at(-1).message).toContain("write denied")
  })
})
