import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { Plugin } from "@opencode/plugin"

export const TOOL = "alg_investigation"
export const HOST_VERSION = "2.3.2"
const BINDING = "algInvestigationBinding"

type Context = Plugin.Context
type Session = Awaited<ReturnType<Context["session"]["get"]>>
type Create = NonNullable<Parameters<Context["session"]["create"]>[0]>
type Prompt = Parameters<Context["session"]["prompt"]>[0]
type Caller = {
  sessionID: Session["id"]
  agent: NonNullable<Session["agent"]>
}

export type WorkerBinding = {
  runId: string
  ownerSessionId: string
  workerSessionId: string
  promptId: string
  checkerAgent: string
}

const checkerRules = [
  { action: "*", resource: "*", effect: "deny" },
  { action: TOOL, resource: "*", effect: "allow" },
] as const satisfies Create["permissions"]

export async function canonicalDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error("LOCATION_UNVERIFIED")
  return realpath(directory)
}

function hasCheckerRules(permissions: Session["permissions"]): boolean {
  return permissions?.length === checkerRules.length &&
    checkerRules.every((expected, i) => {
      const actual = permissions[i]
      return actual?.action === expected.action && actual.resource === expected.resource &&
        actual.effect === expected.effect
    })
}

function allowsResult(permissions: NonNullable<Session["permissions"]>): boolean {
  // Reject ambiguous matching rules instead of overriding a configured denial or approval request.
  for (const rule of [...permissions].reverse()) {
    if (rule.action === TOOL || rule.action === "*") {
      return rule.action === TOOL && rule.resource === "*" && rule.effect === "allow"
    }
    if (/[^a-zA-Z0-9_-]/.test(rule.action)) return false
  }
  return false
}

function bindingMarker(binding: WorkerBinding): string {
  return JSON.stringify([binding.runId, binding.ownerSessionId, binding.workerSessionId, binding.promptId, binding.checkerAgent])
}

export class InvestigationHost {
  constructor(
    readonly context: Context,
    readonly directory: string,
    readonly ownerAgent: string,
    readonly checkerAgent: string,
  ) {}

  async matchesLocation(session: Session): Promise<boolean> {
    return session.projectID === this.context.location.project.id &&
      Reflect.get(session.location, "workspaceID") === undefined &&
      await canonicalDirectory(session.location.directory) === this.directory
  }

  async owner(caller: Caller): Promise<Session> {
    if (caller.agent !== this.ownerAgent) throw new Error("OWNER_REQUIRED")
    const session = await this.context.session.get({ sessionID: caller.sessionID })
    if (session.id !== caller.sessionID || session.agent !== caller.agent || session.parentID ||
        !await this.matchesLocation(session)) throw new Error("OWNER_REQUIRED")
    return session
  }

  async configuredChecker(): Promise<NonNullable<Session["agent"]>> {
    const agentID = this.checkerAgent as NonNullable<Session["agent"]>
    const configured = await this.context.agent.get({
      agentID,
      location: { directory: this.context.location.directory },
    })
    if (configured.data.id !== agentID || configured.data.mode !== "subagent" ||
        await canonicalDirectory(configured.location.directory) !== this.directory ||
        !allowsResult(configured.data.permissions)) {
      throw new Error("CHECKER_POLICY_UNQUALIFIED")
    }
    return agentID
  }

  async verifyWorker(session: Session, binding: WorkerBinding): Promise<boolean> {
    return session.id === binding.workerSessionId && session.parentID === binding.ownerSessionId &&
      session.agent === binding.checkerAgent && session.agent === this.checkerAgent &&
      session.metadata?.[BINDING] === bindingMarker(binding) && hasCheckerRules(session.permissions) &&
      await this.matchesLocation(session)
  }

  async worker(binding: WorkerBinding): Promise<Session> {
    const session = await this.context.session.get({ sessionID: binding.workerSessionId as Session["id"] })
    if (!await this.verifyWorker(session, binding)) throw new Error("WORKER_BINDING_UNVERIFIED")
    return session
  }

  async create(binding: WorkerBinding, owner: Session): Promise<void> {
    const agent = await this.configuredChecker()
    if (binding.checkerAgent !== agent || owner.id !== binding.ownerSessionId || !owner.model) {
      throw new Error("WORKER_CONFIG_UNQUALIFIED")
    }
    const session = await this.context.session.create({
      id: binding.workerSessionId as Session["id"],
      parentID: owner.id,
      title: "ALG investigation checker",
      agent,
      model: owner.model,
      location: { directory: this.context.location.directory },
      metadata: { [BINDING]: bindingMarker(binding) },
      permissions: checkerRules,
    })
    if (!await this.verifyWorker(session, binding)) throw new Error("WORKER_BINDING_UNVERIFIED")
  }

  async prompt(binding: WorkerBinding, text: string, signal: AbortSignal): Promise<void> {
    const session = await this.worker(binding)
    await this.configuredChecker()
    if (signal.aborted) throw new Error("OPERATION_STOPPED")
    const admission = await this.context.session.prompt({
      sessionID: session.id,
      id: binding.promptId as NonNullable<Prompt["id"]>,
      metadata: { [BINDING]: bindingMarker(binding) },
      delivery: "queue",
      text,
    })
    if (admission.id !== binding.promptId || admission.sessionID !== session.id ||
        admission.payload.metadata?.[BINDING] !== bindingMarker(binding)) {
      throw new Error("PROMPT_ADMISSION_UNVERIFIED")
    }
  }

  async assertResultPermission(session: Session): Promise<void> {
    try {
      await this.context.permission.assert({
        sessionID: session.id,
        agent: session.agent,
        action: TOOL,
        resources: ["*"],
      })
    } catch {
      throw new Error("CHECKER_RESULT_PERMISSION_DENIED")
    }
  }

  async authorizedResult(binding: WorkerBinding, caller: Caller, text: string): Promise<Session> {
    if (caller.sessionID !== binding.workerSessionId || caller.agent !== binding.checkerAgent) {
      throw new Error("CHECKER_REQUIRED")
    }
    await this.configuredChecker()
    const session = await this.worker(binding)
    await this.assertResultPermission(session)
    if (!await this.hasPrompt(session.id, binding, text)) throw new Error("PROMPT_UNVERIFIED")
    return session
  }

  async hasPrompt(sessionID: Session["id"], binding: WorkerBinding, text: string): Promise<boolean> {
    const history = await this.context.session.context({ sessionID })
    const users = history.filter(message => message.type === "user")
    const message = users[0]
    return users.length === 1 && message?.type === "user" && message.id === binding.promptId &&
      message.text === text && message.metadata?.[BINDING] === bindingMarker(binding)
  }
}
