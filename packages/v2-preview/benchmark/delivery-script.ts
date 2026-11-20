import { finalInput, object } from "./handoff-case.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { TurnInput } from "./transport.ts"

export const deliveryMarker = "ALG delivery obligation (untrusted recorded data)\n"
export const deliveryCheck = "ALG delivery check: "
export const calculationMarker = "ALG calculated evidence (source data)\n"
export const calculationConflict = "the reported measurement conflicts with the reproducible calculation. Correct the report and reassess any dependent recommendation."
export const calculationMissing = "missing or unverified calculated measurements. Recover the required source evidence before reporting."

export function observeCalculatedEvidence(messages: TurnInput["messages"]) {
  const tagged = messages.flatMap(({ role, content }) => wireTextParts(content)
    .filter(part => part.includes(calculationMarker)).map(part => ({ role, part })))
  const payload = tagged.length === 1 && tagged[0]?.role === "user" && tagged[0].part.startsWith(calculationMarker)
    ? parse(tagged[0].part.slice(calculationMarker.length)) : undefined
  return { projections: tagged.length, values: object(payload?.values) }
}

export function observeDelivery(messages: TurnInput["messages"]) {
  const latestUser = messages.map(message => message.role).lastIndexOf("user")
  const barePrompt = wireTextParts(messages[latestUser]?.content).join("\n") === finalInput ? latestUser : -1
  const tagged = messages.flatMap(({ role, content }) => wireTextParts(content)
    .filter(part => part.includes(deliveryMarker)).map(part => ({ role, part })))
  const statuses = messages.filter(message => message.role === "system")
    .flatMap(message => wireTextParts(message.content))
    .flatMap(part => part.split(/\r?\n/))
    .filter(line => line.startsWith(deliveryCheck)).map(line => line.slice(deliveryCheck.length))
  const ready = statuses.filter(status => /^ready\b/i.test(status))
  const noRereads = ready.length === 1 &&
    /\bno\b[^.!?\n]{0,90}\brereads? (?:is|are) needed\b/i.test(ready[0]!)
  const payload = tagged.length === 1 && tagged[0]?.role === "user" && tagged[0].part.startsWith(deliveryMarker)
    ? parse(tagged[0].part.slice(deliveryMarker.length)) : undefined
  const values = object(payload?.values)
  const fields = payload?.fields
  const revision = payload?.decision_revision
  const valid = payload?.format === "json_object" && Object.keys(payload).length === 4 &&
    values && Array.isArray(fields) && fields.length > 0 &&
    fields.every(field => typeof field === "string" && Object.hasOwn(values, field)) &&
    new Set(fields).size === fields.length && Object.keys(values).length === fields.length &&
    typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
  const reportInStatus = valid && [...Object.keys(values), ...Object.values(values).filter(value => typeof value === "string")]
    .some(value => statuses.some(status => status.includes(value)))
  return { barePrompt, statuses, ready: ready.length, noRereads, reportInStatus: !!reportInStatus, projections: tagged.length,
    values: valid ? values : undefined, revision: valid ? revision : undefined }
}

function parse(text: string) {
  try { return object(JSON.parse(text)) } catch { return undefined }
}

export function deliveryGap(statuses: string[]) {
  if (statuses.length !== 1) return
  const status = statuses[0]!
  if (status === calculationMissing) return "calculation-missing"
  if (/\b(?:superseded|stale|revision|new(?:er)? decision)\b/i.test(status)) return "superseded"
  if (/\b(?:authority|approval|procedure|revoked|withdrawn)\b/i.test(status)) return "revoked"
  if (/\b(?:report fields|source references)\b/i.test(status) && /\b(?:missing|unverified)\b/i.test(status))
    return "missing-reference"
}

export function scriptedDelivery(messages: TurnInput["messages"], observed = observeDelivery(messages)) {
  if (observed.barePrompt >= 0 && observed.statuses.length === 1 && observed.noRereads && !observed.reportInStatus && observed.values)
    return { text: JSON.stringify(observed.values) }
  const gap = deliveryGap(observed.statuses)
  return { text: JSON.stringify({ abstained: true, gap: gap ?? "delivery-unverified" }) }
}
