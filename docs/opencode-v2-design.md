# OpenCode 2 support: design spec

**Status:** Draft 0.4, reconciled 2026-10-17 with the
[umbrella design](skill-knowledge-graph-design.md) and four component contracts.
Based on Claude's Draft 0.2 of 2026-10-13; host-version research remains that dated
snapshot, not a fresh compatibility certification. Nothing here is implemented.

**Delivery boundary:** V2 remains unfinished design work. Do not begin its
implementation phases or phase 0 runtime probe until the user finalizes this
design and explicitly authorizes starting V2. The umbrella program is delivered
on V1 first. Shared interfaces needed by V1 may anticipate these requirements;
that does not authorize a V2 adapter, entry point, SDK dependency, installer or
configuration/database migration, and V2 acceptance must not block V1 delivery.

The umbrella's first V1 phase is approved procedure continuity through compaction
and restart, not phase 1 of the migration table below. It requires neither the
host-port refactor nor a V2 capability probe. The linked design set is canonical;
older copies remain research history. Changes here reconcile contracts only.

**Contract ownership:** [execution](execution-recovery-contract.md) owns recovery,
capabilities, diagnostics and budgets; [knowledge](knowledge-environment-contract.md)
owns provenance/approval; [context](context-decision-contract.md) owns context
allocation/delivery; [coordination](coordination-improvement-contract.md) owns
sharing/observation. This document specifies host mappings, packaging and probes.
Its tables do not define alternative core records or weaken those contracts.

**Scope:** what it takes for `opencode-alg` to install and run on OpenCode 2 while it keeps running
on OpenCode 1.18, and how long-running sessions should work on each host.

**Changes since 0.1.** Draft 0.1 was reviewed independently by Codex, and its findings were checked
against the OpenCode 2.0.27 source and our own code. This draft:

- adds four contracts (section 7): execution recovery, evidence and transcripts, permissions, and
  compatibility;
- corrects five errors: host restart recovery (4.7), the shape of a V2 turn (4.5), the checker's
  tools (6.3), what the compaction hook must do (5.2), and V1 agent files on V2 (8);
- narrows the child-session question, because the create call does accept a parent (4.4);
- proposes caller-chosen ids for worker launch, conditional on tested host semantics (6.3);
- renames the first V2 release an execution preview with a capability table (7.4);
- adds offline install, diagnostics, and an endurance phase (8, 11);
- records that the two known installs run 1.18.35 and 1.18.32 (8).

## 1. Summary

- OpenCode 2 (GA 2026-09-11, latest seen 2.0.27) does not load V1 plugins. There is no
  compatibility layer and none is committed. A V1 plugin wrapped to satisfy the V2 loader loads and
  then does nothing.
- One package can serve both hosts, with a V1 entry and a V2 entry. The two hosts share no hooks, no
  client, and no message model, so each needs its own adapter.
- Most of our modules have no import from the host (section 6). The work is to put a narrow
  interface (a "host port") between that core and the host, then write a V1 adapter (a move of
  existing code) and a V2 adapter (new code).
- **The largest correctness risk is recovery.** OpenCode 2 resumes interrupted sessions itself after
  a restart, at-least-once. Our resume logic today would mark the attempt failed and start a second
  worker while the host revives the first. Section 7.1 is the contract that prevents this.
- Three further areas are redesigns rather than ports: how worker sessions are launched and read
  back, how transcripts are read, and everything in the terminal UI.
- Simplify the host integration now; keep today's durability and verification behaviour until V2
  parity is demonstrated. Changes that would simplify learning or storage wait for the lean-out.
- The open questions in section 12 need a throwaway probe on a real V2 install before this spec can
  be final.

## 2. How to read the evidence

Each claim about OpenCode 2 carries one of these labels.

| Label | Meaning |
|---|---|
| **[docs]** | Stated in the official V2 documentation at opencode.ai/v2/docs |
| **[types]** | Read from the published type declarations of `@opencode/plugin` or `@opencode/schema` 2.0.27 |
| **[source]** | Read from the OpenCode source repository at tag `v2.0.27` |
| **[report]** | Reported by another plugin author or an upstream issue; one source, may be out of date |
| **[unverified]** | Our inference; must be checked on a real V2 host |

Nothing here was run on OpenCode 2. Section 15 lists the sources.

## 3. Goals and non-goals

**Goals**

1. One npm package installs on OpenCode 1.18.29 or newer and on OpenCode 2.0.27 or newer.
2. On both hosts: plan and run graphs, resume after restart without duplicate workers, keep an
   unfinished run visible across compaction, cancel cleanly.
3. On-disk run state uses the shared versioned format. An authorized compatible
   reader may inspect a run; close/cancel and cross-host continuation require the
   shared ownership and effect-reconciliation boundaries (7.4).
4. Preserve validated V1 workflows. Isolate and explicitly test the shared recovery
   and capacity correctness changes rather than promising byte-identical unsafe behavior.
5. The V1 adapter can later be deleted without touching the core.
6. Nothing the configuration enables is silently ignored on a host that cannot do it.

**Non-goals for the first V2 release**

- Full feature parity. The first V2 release is an **execution preview** (7.4).
- Moving run state into the V2 plugin storage API.
- Replacing the learning pipeline's child sessions with one-off model calls.
- A compatibility shim that translates V1 hooks to V2 at runtime.
- Supporting the V2 beta line that used the `@opencode-ai/plugin` name.

## 4. What changed in OpenCode 2

### 4.1 Loading and configuration

| Topic | V1 (today) | V2 | Label |
|---|---|---|---|
| Package | `@opencode-ai/plugin` | `@opencode/plugin`, `@opencode/client`, `@opencode/cli` | [docs] |
| Default export | `{ id, server }` | `{ id, setup }` or `{ id, effect }` | [docs] |
| Dual export | n/a | `{ id, server, setup }`; needs V1 1.18.29+ | [docs] |
| Config key | `plugin: [[path, options]]` | `plugins: [{ package, options }]` | [docs] |
| Options | second factory argument | `ctx.options` | [docs] |
| Local discovery | `.opencode/plugin/` | `.opencode/plugins/`, `~/.config/opencode/plugins/` | [docs] |
| Install | config edit | `opencode plugin add <spec>`; unpinned npm plugins auto-update | [docs] [report] |
| Terminal config | `tui.json` | one global `cli.json`, migrated on first start | [docs] |
| Process model | one server per `opencode` run | one background service shared by every client | [docs] |
| Reload | restart | plugin instances are destroyed and recreated in-process | [docs] [report] |
| Side by side | n/a | not by default; both read the same config directory | [docs] |
| Database | `~/.local/share/opencode/opencode.db` | same path; `OPENCODE_DB` overrides it | [docs] |
| Instruction files | `AGENTS.md`, `CLAUDE.md` fallback | `AGENTS.md` only; the `instructions` config array is accepted but not resolved | [docs] |

A V1 host may also call a dual export's `setup` function itself, in an embedded pass with a reduced
context **[report]**. The V2 preview typings bundled in `@opencode-ai/plugin` 1.18.3 match that: their
context has no session or tool domain **[types]**. A combined export must therefore make `setup` do
nothing when those domains are absent.

### 4.2 Hook mapping for the hooks we register

| Our V1 hook | V2 equivalent | Notes | Label |
|---|---|---|---|
| `tool` (19 tools) | `ctx.tool.transform(editor => editor.add(...))` | Input may be JSON Schema, a Standard Schema (Zod is one), or an Effect schema; result is `{ content, metadata }` | [docs] [types] |
| `experimental.chat.system.transform` | `ctx.session.hook("context")`, edit `event.system` | Runs before every agent model request, including tool continuations | [docs] |
| `experimental.chat.messages.transform` | same `context` hook, read `event.messages` | We only observe | [docs] |
| `experimental.session.compacting` | `ctx.session.hook("compaction")` | Same fields as `context`; can also supply the summary | [docs] [types] |
| `event` | `ctx.event.subscribe({ signal })` | Payload under `data`; live only, no replay, no automatic reconnect; some events arrive twice | [docs] [report] |
| `config` (read role models) | `ctx.agent.list/get`, `ctx.model.default` | Read-only use maps cleanly | [docs] |
| `dispose` | function returned by `setup` | Also runs on hot reload | [docs] |

Transforms must be synchronous and repeatable; file reads and one-time side effects stay outside
them **[docs]**.

### 4.3 What a tool receives

| V1 `ToolContext` field | Used for | V2 | Label |
|---|---|---|---|
| `sessionID`, `messageID`, `agent` | run ownership, card anchor | present, plus call `id` | [types] |
| `abort` | cancel | `context.signal` | [types] |
| `metadata()` | live progress | `context.progress(update)` | [types] |
| `directory`, `worktree` | state root | not on the tool context; `ctx.location.directory` and `ctx.location.project` | [docs] |
| `ask({ permission: "bash", ... })` | shell-gate approval | **absent** from the tool context | [types] |

### 4.4 Sessions

Plugin session methods in 2.0.27 **[types]**: `create`, `get`, `remove`, `switchAgent`,
`switchModel`, `prompt`, `generate`, `command`, `compact`, `synthetic`, `interrupt`, `update`,
`move`, `wait`, `context`.

The HTTP client has more **[source]**: session `list`, `fork`, `active`, a `log` stream, inbox
operations, per-session instruction entries, and a separate message `list` with cursors. Whether a
plugin can reach these through a supported, authenticated route to its own host is open (P5).

| Call | Input | Returns | Label |
|---|---|---|---|
| `create` | optional `id`, `parentID`, `title`, `agent`, `model`, `location`, `permissions`, `metadata` | the session | [source] |
| `prompt` | `sessionID`, `text`, optional `id`, `files`, `agents`, `skills`, `metadata`, `delivery`, `resume` | an inbox admission, not a reply | [source] |
| `wait` | `sessionID` | nothing | [source] |
| `interrupt` | `sessionID` | whether an execution was interrupted | [docs] |
| `context` | `sessionID` | messages since the last compaction | [docs] |

What this means:

- **Prompting is admission, not completion.** The caller admits a prompt with a delivery mode
  (`steer`, the default, or `queue`), then waits, then reads the outcome from the transcript.
- **A worker can be fully configured in one create call**: parent, agent, model and permissions
  together. Two September reports said plugins could not set a parent **[report]**; the released
  input type accepts one. What remains to check is runtime behaviour: that the terminal shows the
  session as a child and that removing the parent removes it (P1).
- **A prompt carries no tool map.** Tool access is permission rules on the session.
- **Retried ids are idempotent.** A prompt or compact request repeated with the same id returns the
  original admission; reusing an id for a different request is a conflict **[docs]**. Whether
  `create` with an existing id behaves the same way is open (P2).
- **Background work** is native: the host `subagent` and shell tools take `background: true` and
  notify the parent when they finish **[docs]**.

### 4.5 Transcript model

V2 messages are a flat typed list, not V1's `{ info, parts }` envelopes **[docs] [source]**.

| Concept | V1 | V2 |
|---|---|---|
| Message kinds | `user`, `assistant` | `user`, `assistant`, `shell`, `compaction`, `synthetic`, `system`, `skill`, `idle`, plus agent, model and location switch markers |
| Assistant body | `parts[]` of many types | `content[]` of `text`, `reasoning`, `tool` |
| Tool state | `pending`, `running`, `completed`, `error`; `output` string | `streaming`, `running`, `completed`, `error`; `content[]` |
| Shell command | a `bash` tool part with `metadata.exit` | its own `shell` message with `exit` and `status` |
| Finish reason | `info.finish` | `finish` (same values) plus `rawFinish` |
| Tokens | `info.tokens.{input, output, cache.read, cache.write}` | `tokens.{input, output, reasoning, cache.read, cache.write}` |
| Compaction | a summary assistant message | a `compaction` message with `summary` and `recent` |
| Session | `id, parentID, title, projectID, directory` | adds `agent`, `model`, `tokens`, `outcome`, `permissions`, `time.idle`, `location` |

**A V2 turn is not one user message and its replies.** A turn is every step since the previous
`idle` marker, including prompts steered in while the session was busy. An `idle` message closes the
turn and carries its outcome (`succeeded`, `failed`, `interrupted`). A shutdown does not record one:
the resumed execution continues the same turn **[source]**. On V1 a turn is the assistant messages
that share one user message as parent.

Every module that reads transcripts depends on the V1 shape: turn boundaries, learning evidence,
the skill catalog hints, session memory capture, the context-usage estimate, and historical review,
which rejects anything it does not recognise.

### 4.6 Events

V2 events are `{ id, created, type, location?, data }` **[report]**. Seen in the wild:
`session.created`, `session.deleted`, `session.execution.started|succeeded|failed|interrupted`,
`session.step.ended`, `session.usage.updated`, `session.compaction.*`, `permission.asked|replied`,
`form.*`, `location.shutdown`. `session.idle` and `session.status` exist in the schema but are not
emitted **[report]**. Subscriptions are live only **[docs]**. Events can prompt work; they cannot be
the record of it.

### 4.7 Host restart recovery

When the managed server starts, it sweeps for executions the previous process left behind
**[source]**:

- Every session with a durable suspended claim is resumed. The host first adds a synthetic message
  telling the model the server restarted and to continue without repeating completed work.
- Recovery is **at-least-once**. Local coordination prevents two concurrent drains; it does not
  prevent repeated external side effects after a crash. There is no idempotency key.
- Each resume is counted durably. After a budget (10 by default) the session is ended as aborted and
  not resumed again.
- Background subagents that were running are resumed and their result delivered to the parent;
  finished ones have their stored result delivered.
- Background shells that were running are **not** restarted. They are marked cancelled.
- Failures of a top-level resume are discarded silently.

A worker session ALG created, and the orchestrator session that was inside an `alg_run` call, are
both ordinary sessions to this sweep.

## 5. Long-running sessions on OpenCode 2

### 5.1 What the host now does itself

| Capability | Behaviour | Label |
|---|---|---|
| Automatic compaction | On by default; triggers near the limit, with a buffer of 10% of the window | [docs] |
| Checkpoint summary | Fixed sections: objective, important details, work state, next move, relevant files; 4,096 output tokens | [report] |
| Incremental update | Later compactions update the same summary; a detail dropped once is gone | [docs] [report] |
| Recent context kept | About 15,000 tokens verbatim; tool output cut to 2,000 characters | [docs] [report] |
| Earlier messages | Stay stored; no longer sent to the model | [docs] |
| Manual compaction | `POST /api/session/{id}/compact`, idempotent by id; plugins call `ctx.session.compact` | [docs] |
| Native provider compaction | Per model, an encrypted checkpoint tied to provider, model and endpoint (OpenAI Responses only) | [docs] |
| Overflow recovery | One recovery compaction and retry | [docs] |
| Restart recovery | Section 4.7 | [source] |
| Instruction baseline | Moves forward at each compaction; `AGENTS.md` changes are detected per request | [docs] |
| Session instruction entries | Keyed per-session instruction entries through the API | [source], undocumented |
| Durable plugin storage | `ctx.storage.get/set/remove/scan`, JSON values | [docs] |
| One-off model call | `ctx.generate.text({ model, prompt })`, no session, no history | [docs] |

Known gaps, all **[report]**: compaction fires only near the limit (no idle-time compaction);
server-mode sessions have reached 400k to 510k tokens uncompacted; large sessions use a lot of
memory.

The division of labour does not change: OpenCode stores the conversation; ALG keeps the
authoritative workflow state and chooses what is brought back into context.

### 5.2 What this means for our design

1. **Recovery is shared with the host, under a contract.** ALG still re-states an unfinished run on
   every request, because the V2 summary is rewritten under a small output cap and can drop a run
   id. But ALG no longer decides alone whether a worker is dead. Section 7.1.
2. **The compaction hook keeps its durable work.** Today the hook commits learning evidence and
   captures results before it builds the memory view; those are writes, not prompt text. The order
   on V2 is fixed: commit evidence and checkpoint, then build the bounded recovery context, then let
   compaction proceed. What gets smaller is only the text: a short block (run id, status, pending
   nodes, resume instruction) aimed at the summary's "work state" and "next move" sections. We do
   not replace the summary.
3. **The allocator is owned by the context contract; its observations are per host.**
   Use available system/tool/message data and provider token accounting, labeling
   estimates and unknown coverage. These bytes do not guarantee exact token counts
   or visibility of later host additions. Reserve reply/uncertainty capacity,
   prioritize mandatory content, and never use a byte floor to exceed capacity.
4. **Prompt caching needs care.** Our injected text changes only when run state changes. On V2 it
   must stay byte-stable between changes and sit where it does not invalidate the host's cached
   prefix (P8).
5. **Native provider compaction is unsupported until tested.** With an encrypted checkpoint the
   host writes no text summary. Per-request injection still works; the compaction hook may not
   (P9). We do not depend on it for any provider.
6. **Deferred until after parity:** proactive compaction through `ctx.session.compact`; session
   instruction entries as the home of the run summary; background `alg_run` that returns at once and
   wakes the parent when the run finishes.

## 6. Target architecture

```
                 ┌───────────────────────────────────────────────┐
                 │ core (no host imports, no host-version checks)│
                 │ graph · executor · store · locks · schemas    │
                 │ context budget · compaction text · skills     │
                 │ learning · memory · environment memory        │
                 └───────────────▲───────────────────────────────┘
                                 │ host port (6.1)
              ┌──────────────────┴──────────────────┐
              │                                     │
   ┌──────────┴──────────┐               ┌──────────┴──────────┐
   │ V1 adapter + V1 UI  │               │ V2 adapter + V2 UI  │
   │ @opencode-ai/plugin │               │ @opencode/plugin    │
   └─────────────────────┘               └─────────────────────┘
```

Rules:

- No host SDK type crosses the port. No `if (host === 2)` in the core.
- One implementation of persistence, validation and learning.
- The V2 adapter uses the Promise API. No Effect rewrite.
- Host session ids are bindings scoped to one host, not ALG identities.

### 6.1 The host port

| Port method | V1 adapter | V2 adapter |
|---|---|---|
| `log(level, message)` | `client.app.log` | host logger |
| `location()` → directory, worktree, project id | `PluginInput` fields | `ctx.location` |
| `requestShape(sessionID)` → window, output reserve, system bytes, tool-schema bytes, used tokens | system and messages transforms | `context` hook event |
| `getSession(id)` | `session.get` | `ctx.session.get` |
| `activeContext(sessionID)` → normalized turns since the last compaction | `session.messages` | `ctx.session.context` |
| `historyPage(sessionID, cursor)` → normalized turns plus coverage | `session.messages` | message list with cursors, if reachable (P5) |
| `listSessions()` | `session.list` | session list, if reachable (P5) |
| `launchWorker(binding, spec)` | create + blocking prompt | create + prompt, both with caller-chosen ids (6.3) |
| `observeWorker(binding)` → shared observation with identity, epoch, coverage and terminal evidence | prompt response/status where supported; unknown where not | `get`, `wait`, transcript read, with conformance |
| `cancel(binding)` → shared stop receipt, never a bare proof-of-stop Boolean | `session.abort` request; confirmed/unknown according to observed coverage | `ctx.session.interrupt` request plus tested terminal/descendant evidence |
| `requestApproval(command)` | `context.ask` | open (P4); fails closed if absent |
| `progress(update)` | `context.metadata` | `context.progress` |
| `showAttempt(card)` | part patch through the private client | section 9 |
| `onTurnClosed`, `onSessionCreated`, `onSessionDeleted` | `event` hook | `ctx.event.subscribe` |

Tool definitions move to a host-neutral table: id, description, a Zod schema, and an executor that
takes a port-level context. The V1 adapter passes them to `tool()`. The V2 adapter registers them
with `ctx.tool.transform`, passing the Zod schema as a Standard Schema; that integration must be
tested, not assumed. Another project found each tool needed `options: { codemode: false }` or calls
failed with "Unknown tool" **[report]**.

### 6.2 Normalized transcript

The core stops reading host messages. Both adapters produce one internal shape, specified in 7.2.
The V1 normalizer is today's logic. The V2 normalizer walks the flat list and closes a turn at each
`idle` marker.

### 6.3 Workers on V2

| Option | How | Verdict |
|---|---|---|
| A. Plugin-created sessions | One `create` with id, parent, agent, model and permissions; `prompt` with an id; `wait`; read the transcript | **Proposed for every worker**, including the checker and the learning children |
| B. Host `subagent` tool | Let the orchestrator model launch workers | Rejected. The model, not the graph, would decide what runs |
| C. `ctx.generate.text` | One model call, no session | **Deferred to the lean-out**, and never for the checker |

Why C is deferred:

- The graph checker is not tool-free. Its agent definition allows read, grep and glob so it can
  verify claims against files. A text-only call would weaken the gate.
- The learning auditor and its checker use no tools, but their sessions are also provenance:
  candidate validation checks the registered auditor and checker sessions and their link to the
  source session. Replacing them needs a durable invocation receipt (role, model, evidence hash,
  prompt version, attempt identity, result, publication identity), a versioned format for it, and
  crash-recovery tests. That is a learning redesign and does not belong in a host migration.

What V2 improves without any redesign: permissions set at creation give the learning children real
tool isolation. On V1 the host has no per-session permission rules, which is why those children run
only behind the `allowBuiltinToolMap` option.

**Caller-chosen ids.** The session id and the prompt id for an attempt are derived from run id, node
id and attempt number, scoped to host instance/database epoch, and written to the
shared attempt binding before either call. Replay of an identical request is allowed
only after P2 proves its idempotency/absence semantics in that epoch. If creation
cannot be reconciled, retain an unknown admission rather than create another worker.

### 6.4 Process and state

- **Run state stays on disk** under `.opencode/` in the project, in a versioned format.
- **Locks stay file-based.** They already exclude a second process, on either host, from mutating a
  run.
- **Reload safety.** V2 destroys and recreates plugin instances in-process. Every timer, cache and
  subscription must be released by the cleanup function, and module-level state that assumes one
  instance per process moves onto the instance.
- **No event replay.** After a reload, a reconnect or a restart, the plugin reconciles from the
  store and the host (7.1), never from remembered events.

## 7. Contracts

These four contracts are requirements on both adapters. Each needs tests before the phase that
relies on it can close.

### 7.1 Execution recovery

The [shared execution contract](execution-recovery-contract.md) is normative on
both hosts. This section maps its receipt fields to the V2 API; it introduces no
second binding/state format.

- Persist run/node/attempt, generation, exact launch request, host identity and
  database-epoch evidence state, and known session/prompt IDs before the associated
  dispatch boundary. Epoch evidence may be unverified/unavailable; an ALG store
  UUID or stable endpoint cannot substitute for verified host continuity.
- Normalize admission, execution, cancellation and external-effect observations
  separately. An idle/terminal marker is not proof all external effects settled.
- V2 host recovery and repeated ALG tool delivery attach/reconcile the same attempt
  under its current ownership fence. They do not allocate another worker.
- A missing session is unknown unless durable same-epoch evidence and tested
  semantics prove the exact request never ran. Deletion, reset and inaccessible
  history cannot be reinterpreted as absence of effects.
- A completed remote result is recovered and validated once. Known invalid output
  retains its typed failure; unknown admission/effects remain unknown.
- Host resumes, provider retries and ALG attempts retain separate counters in one
  cumulative approved budget lineage. Automatic host recovery must have a tested
  stop/cap boundary before unattended work is enabled.
- A closed/cancelled run stops new admissions and requests cancellation of owned
  live workers. Cleanup records confirmation or uncertainty, not silent success.
- V1 also requires reconciliation: lack of native host restart does not prove an
  in-flight session stopped after a request, controller or network interruption.

Implement the shared decision table and tests, including missing-session-after-write,
rather than the former shortcut "missing means nothing ran." Do not start a
conflicting replacement until termination/isolation and effect reconciliation
satisfy the common contract.

Role names and `git status` do not establish safe replacement. Use the installed
effective tool permissions, tested isolation and exact resource/effect receipts;
charge overlapping old/replacement work together. Scope uncertainty to conflicting
operations where justified, rather than blocking unrelated work or context reads.
Operator approval likewise needs proven confirmation provenance: a TUI dialog is
an interface, not automatic protection from SDK/CLI invocation or receipt forgery.
The shared knowledge contract owns that boundary, including headless policy.

### 7.2 Evidence and transcripts

**Two reads, never interchangeable.**

- `activeContext` is the available active transcript, not proof of the complete
  final model request. It contributes to budget estimates and bounded turn capture.
- `historyPage` provides stored transcript pages with explicit coverage. Historical
  review and transcript reconstruction require the declared complete snapshot;
  durable work recovery also uses ALG's own committed records.

**Coverage is explicit.** Every evidence record states `complete` or `partial` with a reason
(compacted, page limit, host route unavailable, gap after reconnect). Historical
skill auditing retains its existing full-coverage candidate/promotion rules.
The knowledge compiler may publish bounded proposed assertions with explicit partial
coverage under its separate contract; that does not satisfy a historical audit or
authorize skill promotion. An event-fed index is a discovery hint, not the evidence
itself. ALG never reads the host's database directly.

**Normalized turn**

```
Turn {
  host, sessionID, snapshotVersion
  inputs:  [{ id, kind: "user" | "steered" | "synthetic", text, createdAt }]   // one or more
  steps:   [{ id, text, finish, tokens, createdAt, completedAt,
              tools: [{ name, status, input, outputText, error, exitCode }] }]
  markers: [{ kind: "compaction" | "restart" | "agent" | "model", at }]
  outcome: "succeeded" | "failed" | "interrupted" | "open"
  error?
  sourceIds: [...]            // every host message id, in order
}
```

- A V2 turn can hold several inputs. A lesson is attributed to the turn and all of its inputs, never
  to one user message chosen by position.
- Provenance for V2 evidence is a new version of the provenance record: session, the ordered input
  ids, the assistant ids, and the id of the closing `idle` marker. V1 provenance keeps its form.
- A V2 successful turn is closed by its authoritative `idle` marker with outcome
  `succeeded`, not by a notification event. Failed/interrupted terminal markers
  retain those outcomes. A restart within a turn is not a new turn. V1 retains
  its separately tested normalization rules.
- Historical review seals a canonical snapshot of host messages. V2 snapshots get a new snapshot
  version and their own strict validator; V1 snapshots keep theirs.

**Compaction boundary.** In the compaction hook: commit evidence and checkpoint, then build the
bounded recovery context, then return. If the commit cannot finish in its time bound, the failure is
logged and the run pointer is still injected.

### 7.3 Permissions

1. **Workers never wait on a person.** Each worker session is created with rules that resolve to
   allow or deny. If a permission request is raised for a worker session anyway, the attempt fails
   with that reason.
2. **Workers cannot call ALG tools or launch subagents.** On V1 this is the per-prompt tool map; on
   V2 it is deny rules on the session.
3. **The checker keeps read, grep and glob, and nothing that writes.** Whether the rules come from
   translated V1 agent files or from the plugin, the effective permissions on V2 are tested: the
   checker must be unable to edit or run a shell, with V2's rule ordering (the last matching rule
   wins) taken into account.
4. **A user's deny still wins** over anything ALG sets.
5. **Shell gates need command-specific approval.** If the V2 host gives a running tool no way to ask
   the user to approve one specific command (P4), shell gates fail closed on V2: the gate does not
   run, the node cannot pass, and the tool result says why.
6. **Learning children are denied every tool** by rules at creation on V2.
7. **Session and project checks stay.** A tool call acts only on runs owned by the calling session,
   and a session is accepted only if it belongs to the plugin's project and location.

### 7.4 Compatibility

**Capability descriptor.** The execution contract defines one versioned descriptor
with verified/unsupported/unverified state and exact conformance receipts. The
table below is the migration target, not a claim that the current build or a
particular installation supports every cell. Runtime status renders actual
descriptor values. The watcher and context features query this same descriptor.

**Capability target table.** The first V2 release is an execution preview.

| Capability | V1 | V2 execution preview | V2 full |
|---|---|---|---|
| Plan, run, resume, close, cancel | yes | yes | yes |
| Shared recovery contract (7.1) | required, conformance gated | required, conformance gated | required, conformance gated |
| Run summary on every request and at compaction | yes | yes | yes |
| Context budgets | yes | yes | yes |
| Shell gates | yes | only if P4 has an answer | yes |
| Skill catalog in context | yes | yes | yes |
| Session memory, environment memory | yes | no | yes |
| Turn capture and learning | yes | no | yes |
| Historical review | yes | no | yes, if P5 has an answer |
| Attempt display | cards | host child sessions or none | panel |
| Terminal commands, role-model inspection | yes | no | yes |
| Offline install, diagnostics | yes | yes | yes |

**Unsupported means refused.** Explicitly enabled features whose required descriptor
entries are unsupported or unverified are rejected during startup validation, with
named options and gaps. Feature targets in this table cannot stand in for receipts.
Unrequested optional capabilities do not block otherwise supported core execution.

**State format.** Run state carries a schema version. Adding the attempt binding raises it. A build
that does not know a version refuses to change that run; it does not drop fields.

**Cross-host handoff.** A readable format does not make a live execution portable.

- An authorized compatible reader may inspect a run. Closing requests a shared
  stop/reconciliation transition and never settles unknown effects by itself.
- Cross-host continuation requires existing ownership-transfer authority,
  termination/isolation and effect reconciliation, current permissions, a new
  ownership fence, and preserved prior bindings. Terminal status alone is insufficient.
- A run lock serializes ALG writes; it does not fence arbitrary remote effects.
  V1 and V2 must not drive conflicting work under different ownership generations.

**Packaging.** Section 8.

**Rollback.** Installing the dual-host package on V1 must be reversible by repointing to the
previous snapshot, with the V1 configuration never rewritten into V2 form.

## 8. Packaging, configuration, install

**Known installs.** The workstation runs OpenCode 1.18.35 and the air-gapped machine 1.18.32. Both
are above 1.18.29, the lowest V1 release that accepts a dual export.

| Item | Proposal |
|---|---|
| Entry points | Preferred: a separate entry file per host, each found through that host's own manifest field, so no V2 code is loaded on V1 (P6). Fallback: one default export `{ id, server, setup }`, where `setup` does nothing unless the session and tool domains are present (4.1). Neither puts a `tui` key on the server export; a host rejects that combination **[report]** |
| `exports` | `.` and `./server`, `./tui` (V2 terminal plugin), `./rpc` (shared contract, section 9) |
| V1 floor | Raise to 1.18.29. No known install is below it |
| `engines.opencode` | `>=1.18.29 <2.0.0 \|\| >=2.0.27 <3.0.0`, matching the support table and nothing wider |
| Runtime dependencies | The shipped adapters import runtime helpers from their host package, so neither can be a dev dependency. Each adapter is built as a self-contained bundle. A test installs the packed artifact with dev dependencies absent and loads it on each host |
| Type drift | A compile-time check against the pinned `@opencode/plugin` version, so an upstream change fails typecheck rather than failing at load |
| Options | Same schema on both hosts; read from `ctx.options` on V2 |
| Agents | Keep `agents/*.md` as the single source. V2 translates V1 agent frontmatter automatically (`permission` → `permissions`, `bash` → `shell`, `task` → `subagent`) **[docs]**. The translated permissions are tested (7.3). Registering agents from the plugin with `ctx.agent.transform` stays available if the translation proves lossy |
| Role models | V1 reads `config.agent[role].model`. V2 reads the agent record; a subagent with no model inherits the parent session's model **[docs]**, which matches our current rule |
| Install on V2 | A `plugins` entry `{ package, options }` pointing at a local package directory, pinned; or `opencode plugin add` with an exact version where a registry is reachable. Directories or packages, not single files **[report]** |
| Offline install | The air-gapped machine has no registry. The release artifact is one archive containing both bundles and every runtime dependency, installed from disk, verified by a clean install with the network off |
| Diagnostics | One status call reports the loaded source fingerprint, package version, host name and version, adapter, state schema version, and the capability table. This is the answer to "the fix is on disk but the running process still has the old code" |
| Installer warnings | Warn when a project relies on `CLAUDE.md` or on the `instructions` config array, neither of which V2 loads |
| Upgrade tooling | `snapshot-upgrade.ts`, the manager, the installer and `live-verify.ts` assume V1: the `plugin` key, `tui.json`, `opencode serve` routes, the V1 database tables, and a hard check that the major version is 1. Each needs a V2 path. None may rewrite configuration a V1 host still reads |

**Running both on one machine.** V1 and V2 read the same config directory, default to the same
database path, and use the same command name; the V2 installer replaces the V1 binary. Until V1 is
retired on a machine, V2 there needs its own binary location, config directory and `OPENCODE_DB`,
with separate launch commands, and the upgrade runbook needs a V2 section that says so.

`DESIGN.md` trails the implementation in places (it still describes fifteen tools; there are
nineteen). The facts this spec depends on are stated here; a full refresh of `DESIGN.md` is separate
work and does not block this document.

## 9. Terminal UI

Today: three palette commands (`/alg-models`, `/alg-runs`, `/alg-live`) built on the V1 terminal
plugin API and OpenTUI 0.4.3, plus worker attempt cards written into the parent transcript through
an undocumented client call. Each card also adds a small entry to the model's history.

| Piece | On V2 | Label |
|---|---|---|
| Terminal plugin API | `@opencode/plugin/tui`, stable, OpenTUI 0.5.17 or newer | [docs] [types] |
| Commands | `context.keymap.layer` | [docs] |
| Dialogs, toasts, routes | available | [docs] |
| New surfaces | slots (`sidebar.content`, `sidebar.footer`, `session.panel`, footer status) | [docs] |
| Data | `context.data.session.*`, `context.client`, events | [docs] |
| Server → terminal live state | plugin RPC: methods and events declared once, exported as `./rpc` | [docs] |
| Attempt cards by patching parts | not carried over | n/a |

Proposal:

1. **Do not carry the V1 card workaround to V2.** Attempt visibility comes from the host's own
   child-session display if worker sessions are real children (P1), and from an ALG graph and
   progress panel (`session.panel`) fed by RPC. Saved run state is the panel's authority; it
   refreshes after a reconnect.
2. **Live progress** uses `context.progress` from the running tool.
3. **`/alg-runs` and `/alg-live`** are rebuilt against RPC methods instead of reading run files
   through the host file API.
4. **Role models stay inspectable and settable.** V2's session model switching changes one
   session's model; it does not replace assigning a model to each graph role.

The terminal UI is not part of the execution preview.

## 10. Testing

| Layer | V1 | V2 |
|---|---|---|
| Core suite (about 800 tests) | unchanged; runs against the port with a fake host | same tests, same fake |
| Adapter tests | existing fake-client tests, moved | new, against a fake `ctx` |
| Contract tests (section 7) | one suite both adapters must pass | same |
| Synthetic failure tests | malformed output, empty reply, delayed completion, permission denial | same, plus compaction and crash boundaries |
| Restart tests | controller/request loss, live old child, stop timeout, retained siblings | same, plus native host resume, deleted session and database-epoch change |
| Installed-package test | packed artifact, no dev dependencies | same, with the network off |
| Type conformance | pinned `@opencode-ai/plugin` | pinned `@opencode/plugin` |
| Live checks | existing scripts: cards, continuity, soak, learning | the same scenarios against an isolated V2 host |
| Provider qualification | the models in daily use | the same models; passing on one provider certifies nothing about another |
| Release gate | requires V1 live evidence | requires evidence from both hosts |

Optional provider features are detected, never selected by model name. Tests run
locally, never on GitHub runners. Live/provider probes need separate authorization.
Use the [shared endurance profiles](coordination-improvement-contract.md#local-long-horizon-acceptance-profiles);
synthetic duration does not establish installed-host or provider reliability.

## 11. Phases

Each phase closes its local gate against the declared V1 compatibility behavior.
Shared correctness repairs are explicit, versioned deltas. These host-migration
phases are distinct from umbrella increments; no duplicate core implementation is
created. All phases below, including the throwaway probe and migration seam, are
deferred until the design is finalized and V2 implementation is explicitly
authorized. V1-needed interfaces may be added under the umbrella's V1 scope without
starting this migration sequence. Sizes are relative.

| Phase | Work | Size | Exit test |
|---|---|---|---|
| 0. Probe | Throwaway V2 plugin on an isolated install; answer P1 to P12; record a real transcript, event stream and restart | S | Section 12 has no open question hidden behind a fallback |
| 1. Seam | Host port, tool table, normalized transcript, attempt binding and schema version; V1 adapter only | L | Suite green; installed-package smoke test passes; no core file imports a host package |
| 2. V2 execution preview | `setup` entry; tools; workers; recovery contract; cancel; `context` and `compaction` hooks; refusal of unsupported options | L | Coding and research diamond graphs pass; a restart creates no duplicate attempt; continuity and soak pass on V2 |
| 3. Continuity and learning | Turn capture from V2 transcripts; evidence coverage; learning children with permission isolation; memory | L | Skills, task state and provenance survive forced compaction and restart; learning live check passes |
| 4. Historical review | Paged history; V2 snapshot version and validator | M | Historical suite passes for both snapshot versions; a review completes live |
| 5. Install and release | V2 install path, offline archive, diagnostics, runbook, upgrade tooling, dual-host release gate | M | Clean install on both hosts from the runbook with the network off |
| 6. Terminal UI | RPC contract; panel; `/alg-runs`, `/alg-live`; role models | L | The commands work on V2; headed and headless runs agree |
| 7. Endurance | Repeated compaction, disconnects, reloads, crashes, cancellation and model switching over days | M | Bounded resource growth; no duplicate promotion or unsafe replay; evidence recoverable |
| 8. Lean-out (later) | Remove the V1 adapter; consider plugin storage, one-off model calls for learning, background runs | M | Decided separately |

**V1 support is removed only when V2 has:** full execution, learning, memory and terminal parity;
clean offline install and rollback; a historical review completed live; the endurance phase passed;
qualification on the providers actually in use; and evidence that retry and recovery do not
duplicate external actions.

## 12. Open questions for the probe

| # | Question | Decides |
|---|---|---|
| P1 | A plugin creates a session with a parent, agent, model and permissions in one call. Does the terminal show it as a child, and does removing the parent remove it? | Attempt display (9), clean-up |
| P2 | Does `create` with an id that already exists return the existing session or fail? Does `prompt` with a repeated id return the original admission? Must ids follow a particular format? | Idempotent launch (6.3, 7.1) |
| P3 | Stop the service while a plugin-created worker is running and while the orchestrator is inside a tool call. What does the host resume, what happens to the in-flight tool call, and what does the plugin see on setup? | Recovery contract (7.1) |
| P4 | How does a running tool ask the user to approve one specific shell command? | Shell gates (7.3) |
| P5 | Can a plugin list sessions and page a session's full stored history through a supported, authenticated route to its own host? | Historical review, learning from history (7.2) |
| P6 | How does each host choose a package's entry file? Can V1 and V2 be pointed at different files in one package? On V1, is a dual export's `setup` called? | Entry points (8) |
| P7 | After `prompt` and `wait`, what exactly is readable for a worker: full reply, tool results, and the reason when the model call fails? | `observeWorker` and failure reporting |
| P8 | Where does text added to `event.system` land relative to the host's system parts, and does prompt caching survive? | Per-call cost in long sessions |
| P9 | With native provider compaction, does the `compaction` hook run and does injected context survive? | Whether those models can be supported |
| P10 | Do V1 agent files translate to permissions that deny what they denied on V1? Is the `compaction` hook awaited, and for how long? | Permissions (7.3), compaction boundary (7.2) |
| P11 | Can native skill attachment/messages, session instruction entries and final-request inspection prove exact revision/bytes and ordering through compaction/revocation without a second injection? | Context contract delivery states; hook availability itself must be verified |
| P12 | What authoritative evidence distinguishes never-admitted from deleted/reset/missing sessions; how are host/database epochs identified, descendants stopped and delayed effects reconciled? | Shared recovery and capability descriptor on both hosts |

## 13. Decisions needed from the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | May the phase 0 V2 probe or migration implementation start now? | No. The owner has deferred both until the V2 design is finalized and starting implementation is explicitly authorized; unresolved probe questions remain open meanwhile |
| D2 | Where does V2 live while both hosts are in use: a second machine, or an isolated binary, config directory and database on the workstation? | Isolated directories on the workstation; the air-gapped machine stays V1 until phase 5 |
| D3 | Lowest V2 version supported | 2.0.27, the version the types and source were read from |
| D4 | Raise the V1 floor from 1.18.0 to 1.18.29 | Yes. Both known installs (1.18.35, 1.18.32) are above it |
| D5 | First V2 release is an execution preview: phases 1, 2 and the install part of 5 | Yes, labelled as a preview, with the capability table and refusal of unsupported options |
| D6 | State storage on V2 | Keep the file store on both hosts; revisit at lean-out |
| D7 | Which providers must V2 be qualified on before V1 is retired? | The models in daily use on each machine; name them here |
| D8 | Accept the V1 removal criteria at the end of section 11 | Yes |
| D9 | Version number for the dual-host release | 0.5.0 |

## 14. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Host and ALG both recover the same attempt | Duplicate workers, repeated external actions | Recovery contract (7.1); caller-chosen ids; restart tests |
| Caller-chosen ids or absence checks cannot prove no prior dispatch | Duplicate worker/effects | Preserve unknown admission; reconcile identity/epoch and effects, or block; a lookup alone is not sufficient |
| A plugin cannot page full history | No historical review or history-based learning on V2 | Capability table says no; never substitute compacted context; raise upstream |
| No command-specific approval from a tool | Shell gates unavailable on V2 | Fail closed; capability table says so |
| V2 plugin API changes in a minor release | Load failure after a host update | Pinned types with a typecheck guard; pinned plugin version; live check on the newest host as a warning |
| Shared config directory, database and command name | A V2 trial breaks the working V1 setup | Isolated directories and launch commands; runbook section; never convert the config V1 reads |
| Hot reload leaves timers or locks behind | Stuck runs, duplicate captures | Instance-scoped state; cleanup tested by loading and unloading twice |
| The seam refactor regresses V1 | Breaks the working installs | Explicit parity and correctness-delta fixtures; local suite, installed-package and authorized live checks |
| Two adapters drift | A fix lands on one host only | Contract tests both adapters must pass |
| Simplifying learning during the migration | Provenance weakened while the host is also changing | Deferred to the lean-out (6.3) |
| Preview mistaken for full support | Learning or memory believed active when it is not | Capability table in status; refusal to load with unsupported options enabled |

## 15. Sources

Official documentation (opencode.ai/v2/docs): `migrate-v1`, `build/plugins`,
`build/plugins/migrate-v1`, `build/plugins/cli`, `build/plugins/rpc`, `build/client`, `plugins`,
`compaction`, `instructions`, `agents`, `troubleshooting`, `api`.

Published types: `@opencode/plugin@2.0.27` (`package.json`, `dist/promise/session.d.ts`,
`dist/promise/tool.d.ts`), `@opencode/schema@2.0.27` (`dist/tool.d.ts`); the V2 preview typings
bundled in `@opencode-ai/plugin@1.18.3`.

Source at `anomalyco/opencode` tag `v2.0.27`: `packages/client/src/effect/api/api.ts` (session
create and prompt inputs, endpoint list), `packages/schema/src/session-message.ts` (turn and idle
marker), `packages/core/src/session/execution/restart.ts` (restart recovery).

Announcement: anoma.ly/notes/opencode-2-0.

Upstream issues and pull requests (anomalyco/opencode): #48138 compatibility layer proposal,
#53706 V1 plugins cannot load, #51095 session subagent API (closed unmerged), #50777 no idle-time
compaction, #42448 compaction on high-output models, #35570 memory use.

Other plugin authors: `alvinunreal/oh-my-opencode-slim` `docs/opencode-v2-compatibility.md`,
`ivopogace/opencode-courier`. Compaction internals: jczhu.com/blog/opencode-v2-compaction-internals.

Our code: host touchpoint inventory taken from `main` at `fb23c71`; `agents/checker.md`,
`src/index.ts` (compaction hook), `src/skill-evolution-store.ts` (candidate provenance checks).

Review: Codex's independent research and its review of Draft 0.1, 2026-10-12.
