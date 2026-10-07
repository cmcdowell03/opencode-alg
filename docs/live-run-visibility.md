# Live ALG run visibility

## Problem and design

ALG creates SDK child sessions, rather than invoking OpenCode's native `task`
tool. Consequently, a parent transcript contains the ALG tool call, not one
native task card per graph node. Child-session creation and parallel execution
are separate from presentation.

The implementation adds an observational UI layer, not a second orchestration
engine. It uses OpenCode's supported tool metadata and TUI extension APIs. It
must not synthesize native task calls, copy child transcripts into the parent
context, modify permission policy, or alter retry and persistence semantics.

## Implementation phases

1. **Durable progress contract.** Publish a versioned, bounded projection after
   successful executor persistence: run identity/revision, owner, mode, state
   counts, and current node attempts with timestamps and child-session IDs.
   Include at most 32 node rows, prioritize unfinished work, and explicitly
   report omitted rows. Exclude prompts, outputs, diagnostics, credentials,
   tool arguments, and model-specific behavior. Retain the final projection
   in the tool result metadata. Observer failures must not change execution.
2. **Live presentation.** Provide an automatic TUI panel and a keyboard-accessible
   live view, preserving the existing `/alg-runs` attempt browser. Show node
   states, retries, time information, and child navigation. Use supported slots,
   not OpenCode's private native-task renderer. The view is independently useful
   on narrow terminals where the sidebar is hidden.
3. **Recovery and authority.** Rehydrate from existing durable run projections,
   scoped to the current project and owner. Metadata is a display hint, not
   authority to navigate into an arbitrary session. Validate the selected attempt
   before navigation. A persisted `running` state alone is not proof that a
   worker is still executing. Label stale or unavailable observations explicitly.
4. **Bounded lifecycle.** Refresh only bounded, relevant state; serialize reads;
   fence late responses after route changes; clean up timers and subscriptions.
   Do not read child transcripts, start models, or create extra tool calls to
   render the view. UI failure must never block the executor.
5. **Verification and PR update.** Exercise synthetic parallel workers and
   mid-flight child creation, retry/resume/dry behavior, final metadata,
   ownership/corruption checks, restart recovery, read bounds, and disposal.
   Run focused regression tests and type checking. Independently review design
   and failure boundaries before committing to the existing PR.

## Scope and compatibility

- Model-agnostic; no MiniMax, DeepSeek, or other provider branches.
- No durable run-schema migration, additional database, or background daemon.
- No changes to the source-loaded deployment or local OpenCode configuration.
- Native task cards are not an available public extension point in the inspected
  OpenCode 1.18.x TUI API. The supported ALG panel is deliberately distinct.
- This change covers graph execution through `alg_run` and `alg_resume`.
  Historical skill-mining chunks use a separate durable engine and are not
  represented as graph nodes by this view.

## Acceptance criteria

- Two concurrent children are visible before either finishes.
- Ready/waiting, running, failed, skipped, and completed states are distinguishable.
- Retry history remains available through `/alg-runs`; the live view shows the
  current attempt and retry count without duplicating execution state.
- Restarting the UI can reconstruct a run from durable records without a new
  model call, while clearly distinguishing saved state from current liveness.
- Missing, mismatched, stale, or corrupt records never authorize navigation.
- UI errors, slow reads, and cancellation do not change execution outcomes.
- All intervals/listeners are disposed; late responses cannot replace another
  parent's display.
- The parent model receives no additional child transcript or progress narrative.

## Validation boundary

The panel labels its data **last-saved progress**. Refreshing a durable projection
is not a worker heartbeat: an old `running` row can survive process termination.
Attempt durations are wall-clock spans ending at completion or at the last saved
observation, not CPU time or proof of continued activity.

`/alg-live` supports **Up/Down** to select a node and **Enter** to open its child.
Navigation checks the exact displayed attempt and session against a fresh saved
projection; a newer retry must not silently replace the selected destination.

Independent review repaired full-state recovery, dialog renderer ownership,
stale duration calculation, exact-attempt navigation, and keyboard-interceptor
cleanup. The post-repair focused suites passed 11 live-view tests (including a
synthetic OpenTUI render) and seven progress contract/integration tests. TypeScript
checking and whitespace validation also passed. These suites overlap the wider
regression run; their counts must not be added together as independent coverage.
The final seven-file regression run passed **117/117 tests and 1,750 assertions**,
covering the new progress/live-view suites plus the existing TUI, executor,
model/session/plugin, and reliability/observability suites. One pre-existing
diagnostic assertion was corrected to expect the sanitizer's intentional redacted
field name; production diagnostic behavior was unchanged.

Synthetic tests are the acceptance environment. A real headed OpenCode run in
the air-gapped deployment remains a separate manual smoke check after copying
the updated source and restarting OpenCode. Passing synthetic tests does not
establish visual or version compatibility with an uninspected deployment.

### Deployment smoke checklist

1. Copy the reviewed source/package to the deployment using the existing install
   procedure. Confirm both server and TUI registrations point to the same package,
   then restart OpenCode; changing source files does not update an already loaded
   plugin process.
2. Open `/alg-live` in a parent session. An empty parent should produce an empty
   view or an explanatory notice, not display another parent's runs.
3. Use a no-model dry graph to check saved states and the absence of invented
   child links. Then observe an ordinary live graph with independent ready nodes:
   child IDs and progress should appear before the outer ALG tool returns.
4. Open a child from the live view, return to the parent, and inspect earlier
   attempts with `/alg-runs`. Change parent sessions and verify the previous
   parent's state is not retained in the new display.
5. Reopen the UI with existing run records. Confirm recovery is read-only and a
   saved running record is not portrayed as a verified active worker. Execution
   resumes only through the existing explicit `alg_resume` workflow.
