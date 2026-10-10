import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createElement, insertNode, setProp, spread } from "@opentui/solid"
import type { BaseRenderable } from "@opentui/core"
import {
  currentTuiOwner,
  elapsedLabel,
  formatLiveState,
  navigateToSavedChild,
  type LiveRunController,
  type LiveViewState,
} from "./tui-live.ts"

export type LiveSurface = { element: BaseRenderable; dispose: () => void; handleKey: (key: string) => boolean }

function element(tag: string, props: Record<string, unknown>, children: BaseRenderable[] = []): BaseRenderable {
  const parent = createElement(tag)
  spread(parent, props)
  for (const child of children) insertNode(parent, child)
  return parent
}

function textNode(content = "", onMouseDown?: () => void): BaseRenderable {
  const node = createElement("text")
  spread(node, {
    content,
    ...(onMouseDown ? { onMouseDown } : {}),
  })
  return node
}

function isChildNavigable(state: LiveViewState, node: NonNullable<LiveViewState["progress"]>["nodes"][number]): boolean {
  return state.progress?.mode === "live" && node.agent !== "shell" && Boolean(node.session_id)
}

function makeSurface(api: TuiPluginApi, controller: LiveRunController, owner: string): LiveSurface {
  const heading = textNode("ALG live · last-saved progress")
  const summary = textNode("Loading last-saved progress…")
  const rows = Array.from({ length: 32 }, () => textNode())
  let selectedId: string | undefined
  let visibleNodes: NonNullable<LiveViewState["progress"]>["nodes"] = []
  const activateSelected = () => {
    const selected = visibleNodes.find((node) => node.id === selectedId)
    const state = controller.snapshot()
    if (!selected || !state.progress || !isChildNavigable(state, selected)) return
    const generation = controller.currentGeneration()
    void navigateToSavedChild(api, controller, owner, state.progress.run_id, selected, generation).catch(() => {})
  }
  const handleKey = (key: string): boolean => {
    if (key === "up" || key === "down") {
      if (!visibleNodes.length) return false
      const index = visibleNodes.findIndex((node) => node.id === selectedId)
      const next = key === "down" ? Math.min(visibleNodes.length - 1, index + 1) : Math.max(0, index <= 0 ? 0 : index - 1)
      selectedId = visibleNodes[next]?.id
      renderRows(controller.snapshot())
      return true
    } else if (key === "return" || key === "enter") {
      activateSelected()
      return true
    }
    return false
  }
  const root = element("box", {
    border: true,
    flexDirection: "column",
    padding: 1,
    gap: 0,
    title: "ALG live",
    focusable: true,
  }, [heading, summary, ...rows])
  let lastGeneration = -1
  const renderRows = (state: LiveViewState) => {
    const progress = state.progress
    visibleNodes = state.owner === owner && progress ? progress.nodes : []
    if (!visibleNodes.some((node) => node.id === selectedId)) selectedId = visibleNodes[0]?.id
    for (let index = 0; index < rows.length; index++) {
      const node = visibleNodes[index]
      if (!node || !progress) {
        setProp(rows[index]!, "content", "")
        continue
      }
      const child = isChildNavigable(state, node)
      const selected = node.id === selectedId
      const prefix = `${selected ? "› " : "  "}${node.id} · ${node.agent} · ${node.status === "ready" ? "waiting / ready" : node.status} · retries ${node.retries} · ${elapsedLabel(node, progress)}`
      const label = `${prefix}${child ? ` · open child ${node.session_id}` : ""}`
      const capturedGeneration = controller.currentGeneration()
      const activate = child
        ? () => {
            selectedId = node.id
            if (lastGeneration !== capturedGeneration || currentTuiOwner(api) !== owner) return
            void navigateToSavedChild(api, controller, owner, progress.run_id, node, capturedGeneration).catch(() => {})
          }
        : () => { selectedId = node.id; renderRows(controller.snapshot()) }
      spread(rows[index]!, { content: label, onMouseDown: activate })
    }
  }
  const unsubscribe = controller.subscribe((state) => {
    setProp(summary, "content", formatLiveState(state, Date.now(), false))
    const progress = state.progress
    const generation = controller.currentGeneration()
    renderRows(state)
    lastGeneration = generation
  })
  return { element: root, dispose: unsubscribe, handleKey }
}

export function createLiveDialog(
  api: TuiPluginApi,
  controller: LiveRunController,
  owner: string,
): LiveSurface {
  return makeSurface(api, controller, owner)
}
