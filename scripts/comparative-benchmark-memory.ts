import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"

const skillName = "evidence-recovery"
const scopedMemory = (project: string) =>
  new SessionMemoryRuntime(project, { mode: "assist" }, [".opencode/skills"], [])

/** The benchmark operator owns the isolated project's public skill and accepted-job receipt. */
export function initializeComparativeMemory(project: string, recipient: string, handoff: string) {
  const memory = scopedMemory(project)
  const checkpoint = memory.current(recipient)
  if (checkpoint.deleted || checkpoint.delegation) throw new Error("Expected a live root controller for handoff")
  if (checkpoint.revision === 0) memory.beginTask(recipient, "Continue the particle investigation", [handoff])
  else if (!checkpoint.constraints.includes(handoff)) {
    memory.update(recipient, current => ({ ...current, constraints: [...current.constraints, handoff] }))
  }
  const skill = memory.index.search(skillName).skills.find(entry => entry.name === skillName)
  if (!skill) throw new Error("The public recovery skill is missing from the isolated project")
  memory.bindSkill(recipient, skill.key)
}

/** Read only what the real plugin published. Preparing a new context here would invalidate the measurement. */
export function verifyComparativeMemory(project: string, recipient: string) {
  const memory = scopedMemory(project)
  const checkpoint = memory.current(recipient)
  const skill = checkpoint.skills.find(entry => entry.name === skillName)
  const delivery = memory.store.delivery(recipient)
  if (!skill || !delivery || delivery.value.hook !== "system" || delivery.value.state !== "emitted" ||
    delivery.value.context.state !== "prepared" || !delivery.value.context.selected.includes(skill.id))
    throw new Error("No emitted system-hook receipt includes the recipient's bound recovery skill")
  return { owner: recipient, skill_id: skill.id, delivery_id: delivery.id, context_hash: delivery.value.context.context_hash }
}
