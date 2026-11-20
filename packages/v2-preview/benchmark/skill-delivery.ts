import type { RequestObservation } from "./compaction.ts"
import type { Message } from "./transport.ts"

const roles = ["system", "developer", "user", "assistant", "tool"] as const
type Role = typeof roles[number] | "instructions" | "unclassified"
type Pin = { id: string; sha256: string; witness: string }

// Read only provider-visible text parts. Metadata and role-looking text in a payload have no role authority.
export function wireTextParts(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap(part => part && ["text", "input_text", "output_text"].includes(part.type) &&
    typeof part.text === "string" ? [part.text as string] : [])
}

function containsToolBody(text: string, pin: Pin) {
  // The investigation tool can return the procedure inside a serialized JSON result.
  try {
    const result = JSON.parse(text)
    return result?.ok === true && result.procedure?.id === pin.id &&
      result.procedure.sha256 === pin.sha256 && result.procedure.content === pin.witness
  } catch { return false }
}

export function observeSkillDelivery(messages: Message[], pin: Pin | undefined) {
  const found = new Set<Role>()
  const projected = new Set<Role>()
  if (pin?.witness) {
    const projection = "ALG current approved research procedure " + pin.id + " (SHA-256 " + pin.sha256 + ")\n" + pin.witness
    for (const message of messages) {
      const role = message.wireSource === "responses.instructions" ? "instructions" :
        roles.find(role => role === message.role) ?? "unclassified"
      for (const text of wireTextParts(message.content)) {
        if (text.includes(pin.witness) || (role === "tool" && containsToolBody(text, pin))) found.add(role)
        if ((role === "system" || role === "developer" || role === "instructions") && text.includes(projection)) projected.add(role)
      }
    }
  }
  return { bodySha256: pin?.sha256 ?? null, roles: [...found], projectionRoles: [...projected] }
}

type Witness = { requestId: number; stage: "continue" | "summary"; observedAtMs: number; summarySha256: string | null;
  skillDelivery: ReturnType<typeof observeSkillDelivery> }

export function continuationSkillDelivery(witnesses: Witness[], requests: RequestObservation[],
  summary: string | null, answerAt: number | undefined, pinHash: string | undefined) {
  const ordinary = requests.filter(row => row.kind === "ordinary" && row.role === "root")
  const observed = ordinary.map(request => {
    const matches = witnesses.filter(row => row.stage === "continue" && row.requestId === request.id)
    const row = matches.length === 1 ? matches[0] : undefined
    if (request.status !== 200 || request.finishedAtMs === null || answerAt === undefined || request.finishedAtMs > answerAt ||
        !row || !(request.startedAtMs <= row.observedAtMs && row.observedAtMs <= request.finishedAtMs && row.observedAtMs < answerAt) ||
        !summary || row.summarySha256 !== summary ||
        !pinHash || row.skillDelivery.bodySha256 !== pinHash) return null
    return { requestId: request.id, ...row.skillDelivery }
  })
  const complete = observed.length > 0 && observed.every(row => row !== null)
  const samples = observed.filter(row => row !== null)
  return { complete, requests: samples, roles: [...new Set(samples.flatMap(row => row.roles))],
    projectionRoles: [...new Set(samples.flatMap(row => row.projectionRoles))] }
}
