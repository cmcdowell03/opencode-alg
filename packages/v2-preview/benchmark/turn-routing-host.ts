import { randomUUID } from "node:crypto"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { bookkeeping, naturalLongOrder, runNaturalLongArm } from "./natural-long-host.ts"
import { measureTurnRouting } from "./turn-routing-metrics.ts"
import { turnRoutingScript } from "./turn-routing-script.ts"

export const routedArm = "alg-routed-compact" as const
export const turnRoutingArms = ["build", "build-focused", routedArm] as const
export type TurnRoutingArm = typeof turnRoutingArms[number]
export const turnRoutingOrder = (index: number) =>
  naturalLongOrder(index).map(arm => arm === "alg-graph-focused" ? routedArm : arm)

export const triageBookkeeping = (id: string) => id === "willow-yard" ? bookkeeping :
  bookkeeping.replace(" with ID carrier-calibration", " with a concise distinct ID of your choice")

// OpenCode normally reads this cached project ID from the common Git directory.
// The isolated fixture supplies empty repository metadata without an external Git runner.
async function fixtureProject(scratch: string) {
  const directory = join(scratch, "project")
  const metadata = join(directory, ".git")
  await mkdir(join(metadata, "objects"), { recursive: true })
  await mkdir(join(metadata, "refs"))
  const id = randomUUID().replaceAll("-", "")
  await writeFile(join(metadata, "HEAD"), "ref: refs/heads/fixture\n", { flag: "wx" })
  await writeFile(join(metadata, "opencode"), id + "\n", { flag: "wx" })
  return { directory: await realpath(directory), id }
}

type Options = Omit<Parameters<typeof runNaturalLongArm>[0], "arm" | "adapter"> & { arm: TurnRoutingArm }

export async function runTurnRoutingArm(options: Options) {
  const installed = options.arm === routedArm
  let routing: ReturnType<typeof measureTurnRouting> | undefined
  const result = await runNaturalLongArm({ ...options, arm: options.arm === routedArm ? "alg-graph-focused" : options.arm,
    adapter: { fixtureProject, scripted: turnRoutingScript, triageBookkeeping: triageBookkeeping(options.fixture.id),
      ...(installed && { turnRouting: "routed-compact" }),
      observe: evidence => { routing = measureTurnRouting({ ...evidence, fixture: options.fixture, bundleSha256: options.bundleSha256 }) },
    },
  })
  if (!routing) throw new Error("ROUTING_EVIDENCE_UNAVAILABLE")
  return { ...result, routing }
}

