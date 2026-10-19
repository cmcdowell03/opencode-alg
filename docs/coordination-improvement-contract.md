# Coordination and improvement contract

Status: Draft component contract, 2026-10-17. Part of
[durable operational context and execution](skill-knowledge-graph-design.md).
These are implementation requirements, not currently supported configuration.

This contract owns run-scoped knowledge delivery, handoffs, milestone observation,
bounded improvement proposals and evaluation. The incident watcher is an intake
client of the same executor, not another orchestrator. Observation is independent
of worker claims, not independent authority to execute.

Delivery targets V1. The shared contracts leave room for V2, whose design and
implementation remain a separate deferred track, not a prerequisite for V1 work.

## Owned records and interfaces

| Record | Owner and meaning |
| --- | --- |
| Run membership | Run store: authenticated host/parent/child bindings, roles, allowed record kinds, membership epoch and revocation. |
| Coordination event | Run sequence and exact visible finding/handoff/correction references; source membership epoch and intended roles/resources. |
| Recipient cursor | Delivered and acknowledged eligible events, pending omissions and snapshot watermark; not proof of understanding. |
| Milestone receipt | Exact criterion/verifier/dependency revisions, evidence and disposition, attached to the executor-owned plan. |
| Observer finding | Shared diagnostic envelope plus checked revision vector; cannot change execution authority. |
| Watch admission | Incident/occurrence revision, approved policy, work item and budget reservation references; committed before dispatch. |

Membership and task assignments stay in the run store. Knowledge content stays in
its existing immutable store. No multi-store atomicity is assumed: publish exact
references with idempotent outbox/admission receipts, reconcile incomplete writes,
and recheck current scope at delivery.

Illustrative handoff:

```json
{
  "kind": "handoff-proposed",
  "runRef": "run:investigation-17@revision",
  "fromAttempt": "attempt:explore-1@revision",
  "toRole": "analyst",
  "artifactRefs": ["artifact:pagination-evidence@digest"],
  "remainingChecks": ["check:dataset-completeness@revision"],
  "nextOperation": "dataset.read",
  "membershipEpoch": 4,
  "effectReconciliationRef": "reconciliation:read-only-17@revision",
  "state": "awaiting-recipient-acceptance"
}
```

Acceptance does not transfer ownership by itself. Only the executor can commit an
assignment after scope, budget and lifecycle checks.

## Run scoped coordination

### Membership and publication

Add an opt-in run visibility scope between private sessions and project publication.
The run store defines membership from host-validated parent/child identities and
committed attempts, never from model-supplied session IDs. A configured sharing
policy names eligible record kinds, source scopes, recipients, and roles. Without
that policy, sibling sessions do not gain access merely by sharing a parent.

Run records use the existing immutable memory store with a run-bound head and typed
scope. Membership changes are revision-fenced in the run store and checked before
reads, ranking, traversal, publication, and delivery. Removed/replaced workers lose
future access; no claim is made that previously delivered context can be erased.
Restart restores membership and cursors from committed records, not process memory.

Publish only explicitly eligible findings, source artifacts, and verification
receipts under the sharing policy. A private source cannot be cited through a
shared edge that exposes it indirectly. Either the complete needed evidence closure
is already visible to recipients, or an authorized bounded evidence snapshot is
published in the run scope first. Otherwise withhold publication and expose a
scope-safe gap. Do not copy transcripts, private reasoning, credentials, or other
sessions' decisions by default. Run publication does not authorize project export.

A finding may be proposed, supported, disputed, or refuted; sharing never upgrades
that state. Corrections identify the exact superseded record and retain history.
An urgent model-authored warning remains a claim, not a new mandatory policy.
Checkers receive role-filtered verification inputs, not sibling strategy chatter
or private conclusions presented as facts.

### Delivery and handoffs

Maintain an append-only run event sequence and per-recipient delivered/acknowledged
cursors. Events carry references and small safe summaries, not repeated full bodies.
Before the next planning request, resolve applicable unread events against current
membership, source revisions, and task scope. Reconstruct the same backlog after
compaction or restart. Record which exact event revisions were emitted in which
request; emission or acknowledgement does not prove understanding or compliance.

Use at most 32 event references per delivery batch, subject to the shared context
budget. Retain omitted eligible events and a continuation cursor. Never advance a
delivery cursor past an eligible event omitted for budget or unsuccessfully emitted.
Track policy-filtered events separately from delivered events without exposing
hidden identifiers or counts; ineligible traffic must not block a recipient's queue.
A validated invalidation of a
required input must be reconciled before a covered dependent action; optional
unread discussion must not stall unrelated work. A new recipient receives a scoped
current snapshot plus a cursor, not an unbounded replay of the run's history.
Bind the snapshot to its source revision vector and event watermark, then replay
later eligible events without a gap; revalidate membership before emission.

The task board is a projection of committed DAG assignments, ownership, blockers,
and handoff receipts, not a competing scheduler. Only the existing executor commits
assignment changes. A handoff names the artifact/evidence revisions, remaining
checks, next step, and recipient acceptance. Lease expiry alone does not transfer
mutation authority while the previous worker may still act. Knowledge availability
and safe execution ownership are separate checks.

Example: an explorer observes an API pagination cap and publishes a reproducible
finding under the run policy. Before a sibling exports a dataset, routing delivers
the finding and its applicable reviewed procedure. A checker independently checks
completeness against evidence; the explorer's message is not a passing verdict.

## Milestones and bounded replanning

Extend the existing run plan with verifiable milestones, prerequisite references,
verifier identity, expected waiting conditions, and evidence requirements. Record
the current hypothesis and the observation/test that can support or refute it.
Model messages and completed tool calls are activity; only validated criterion
evidence advances a milestone. The planner cannot weaken success criteria or
change the user objective merely to escape a stalled state.

Use fixed failure categories plus exact operation/environment/procedure revisions
to recognize repeated failures under unchanged conditions. Do not use arbitrary
raw commands, secret-bearing payloads, or rewritten prose as identity. New wording
does not count as a new hypothesis; name the changed premise or new diagnostic.
Normal polling under an explicit wait contract is not failure or lack of progress.

The initial opt-in policy flags three equivalent known failures across the current
milestone, or an expired declared wait/progress deadline, as `replan_required`.
Existing smaller attempt caps and deterministic preflight failures take precedence;
this rule never authorizes additional attempts. Thresholds belong to the sealed
plan, not model-controlled tool arguments. Unknown outcomes invoke lifecycle
reconciliation, not an ordinary diagnostic retry.

A replan proposal must choose a changed hypothesis with new evidence, a bounded
diagnostic, decomposition, an authorized handoff, or operator escalation/stop.
Allow at most one accepted automatic replan for the same stall signature without
new evidence; unresolved repetition returns a visible blocker. Each replan
consumes the original remaining run budgets and records a plan revision. It cannot
raise spending limits, broaden permissions, drop gates, or mark failed work done.

The existing executor validates and commits any approved graph revision, checking
dependencies and cycles. Carry forward only completed outputs whose assumptions
remain valid; preserve superseded plans and all attempt history. Independent
branches stay complete. The progress evaluator proposes transitions and never
launches a second scheduler or executes repairs itself.

## Independent observation

Extend the existing [live-run visibility](live-run-visibility.md) projection with
a read-only observer of durable records and explicitly permitted liveness/effect
checks. Its independence is from worker claims, not a promise of independent model
judgment. Implement deterministic checks first:

- A reported completion lacks required verification or contradicts current evidence.
- Saved running state lacks fresh liveness evidence; label it unknown, not dead.
- Assignments or handoffs conflict on a covered mutation scope.
- A cancelled or stale generation attempts another covered action or publication.
- Milestones stall, hard budgets expire, or required inputs become stale.

Observer findings have fixed codes, evidence references, scope, severity, and the
revision vector checked. Store findings separately from execution authority and
show them in status/live views. No transcript copying is required. A claim correction
links the original record; the observer does not rewrite the historical outcome.

Observation cannot authorize repair, reassign work, spend model calls, or broaden
read access. Optional model review is explicitly budgeted, sampled, and advisory;
its output cannot approve its own finding or veto an action. Deterministic safety
checks belong at covered dispatch boundaries regardless of observer availability.
Only configured executor policy may react to an authoritative violation. UI or
observer failure must not become a second source of execution state or disable
those safety checks. Do not create an always-running observer model by default.

## Incident intake and controller boundaries

The [incident watcher](incident-watcher-design.md) adds source scanning and a
bounded admission queue. Its lease controls scan/admission writes, not worker
liveness. On takeover it reconciles existing work through the
[execution contract](execution-recovery-contract.md#reconciliation-before-dispatch)
before admitting conflicting work.

One schema-owned failure envelope serves run outcomes, observer findings and
watcher breaker decisions. Its semantic category is separate from an incident
fingerprint. Fingerprints group occurrences within explicit project/source/
environment/principal scope; they cannot prove causality or authorize reuse of a
fix. Preserve meaningful error/status codes, ports and version distinctions under
a versioned normalization rule; ambiguous matches remain separate or flagged.

The watcher scheduler admits work under quotas. The executor alone schedules DAG
nodes, owns attempts and performs cancellation/reconciliation. A model observer,
compiler or learning child cannot create a new run as an unapproved side effect.
A diagnostic budget is not remediation authority. The first watcher remains
diagnose-only; explicit approved remediation is a separate later feature.

Use a durable admission reservation binding incident revision, work ID, policy and
budget before host creation. A crash after creating a session but before saving its
binding is an unknown admission, not permission to create another. Reconcile the
shared attempt/admission identity. Unknown charges remain reserved.

The observer and watcher have different triggers, but consume the same categories:
an infrastructure failure may open the configured provider-scoped breaker; a real
checker rejection does not. A known invalid output is not a transport outage.
Breaker/queue state survives restart, and deadlines/budgets do not reset at a
controller handoff. Capability coverage comes from the shared host descriptor.

## Learning loop

After independently verified work, eligible evidence may enter the knowledge
compiler under its own explicit policy and budget. Candidate lessons retain source
scope, verification limits and original failure history. Promotion of a helper,
skill or applicability rule follows the knowledge approval path. A lesson that
claims its own success is not an independent evaluation.

Measure whether later work becomes more accurate or less wasteful, including
cases where a prior solution is deliberately withheld because the environment
changed. Do not optimize for number of stored lessons, graph edges, messages or
active agents. Preserve competing hypotheses and negative results when they are
eligible evidence, rather than just indexing successful narratives.

## End-to-end acceptance scenario

1. Create synthetic dashboard, dataset, API, repository, and host records with exact
   resource identities, known grain/timezone requirements, and read-only scope.
2. Ask why dashboard totals disagree without naming a skill. Before committing a
   query plan, select the required complete procedures and record why each applies.
3. Record a supported diagnostic resolution and its exact environment/test/source
   references. Compile a reusable lesson, retaining its evidence classification.
4. Compact twenty times, restart, and continue. Recover the same task, decisions,
   required instruction revisions, and eligible resolution without user reminders.
5. Change the timezone procedure or dataset version. Reject stale current-use
   evidence immediately; identify affected decisions while leaving unrelated work
   complete. Historical queries must still explain the earlier decision correctly.
6. Inject a malformed compiler child, an unknown transport outcome, and a crash
   after publication. Preserve independent committed work, expose coverage holes,
   and avoid duplicate calls/commits where a publication receipt already exists.
7. Run health checks and export an inspection view. It must show the correction,
   source lineage, remaining uncertainty, and exact loaded procedures without
   exposing a different session's private evidence or granting new permissions.
8. Start authorized explorer/analysis siblings and a separately scoped checker.
   Publish a verified pagination limit and tested read-only helper into the run.
   The analysis worker must receive the lesson before its dependent request and
   reuse only the exact validated helper. After compaction and membership change,
   recover pending delivery without exposing private evidence or checker chatter.
9. Cancel a worker with an unsettled synthetic external operation, delay its abort
   acknowledgement, and expire its lease. Block a conflicting replacement until
   stop/isolation and effect reconciliation are evidenced. Reject a late stale
   completion without replaying the external operation or losing prior artifacts.
10. Inject a false success report, three equivalent known failures, and an expected
    long wait. Verify progress from independent evidence, distinguish waiting from
    stalling, and allow only the configured bounded replan. Repeat with the observer
    unavailable: executor ownership and dispatch checks must still hold.

## Required regression matrix

- Discovery without skill names; synonyms that produce only advisory candidates;
  exact resource rules; same-name skills from different sources; incomplete indexes.
- Data science: join grain, timezone, dataset snapshot, units, and leakage-prevention
  prerequisites selected before an analysis decision, not after a wrong result.
- Troubleshooting: retained competing hypotheses, known failed tests, verified
  resolutions, and required revalidation after a route or API version changes.
- Compaction before/after binding, restart without in-memory hints, resumed task,
  sibling children, checker isolation, revoked skill, changed dependency, and quota failure.
- Oversized required closures, shared prerequisites, dependency cycles, contradictory
  instructions, zero available budget, and no silent truncation; default versus
  explicitly raised hard caps without expanding optional content or compaction caps.
- Concurrent writers, failed CAS, interrupted object/head/index writes, duplicate
  host events, out-of-order callbacks, missed compaction events, and stale request receipts.
- Late-imported evidence, unknown times, future/invalid timestamps, historical
  queries without hindsight leakage, and current queries that respect revocation.
- Private reverse links, unpublished resolutions, malicious manifest/proposal text,
  suspicious credential content, and denied cross-project references; model-invoked
  approval endpoints, forged receipts and confirmation digest/scope changes.
- Legacy-mode parity, learning disabled, migration/downgrade boundaries, ZIP source
  relocation with explicit identity mapping, and V1 adapter contracts. Future V2
  adapter fixtures are deferred; generic fake-host fixtures imply no V2 support.
- Compiler duplicate intake, completed-invalid versus unknown child outcomes,
  budget/deadline persistence, cancellation races, and independent-unit recovery.
- Crashes before reservation, after dispatch, after rejection, between immutable
  writes and head publication, and between publication and queue acknowledgement.
- Changed source during extraction/publication, invalidated dependencies during
  traversal, unavailable original bytes, source deletion, and stale derived indexes.
- Unsupported private-call permissions, source prompt injection, unsafe citation
  URLs, malformed source spans, and attempts to promote a proposed claim or skill.
- Circular derivation, shared-source false corroboration, generated-output capture
  loops, missing chunk coverage, and unsupported global conclusions from partial jobs.
- Incorrect knowledge before and after compaction: restoring a mistaken hypothesis
  must not upgrade it to fact; expired resolutions must not suppress new diagnostics.
- Health-check completeness, untrusted conflict proposals, scoped omission counts,
  export path redirection, manifest-last failure, and private backlink leakage.
- Run membership spoofing/revocation, role-filtered checker inputs, unauthorized
  publication closures, delivery after revocation, duplicate/out-of-order events,
  backlog overflow, and crashes between emission and cursor acknowledgement.
- Helper byte/lockfile drift, unsupported runtime, expired or wrong-environment
  validation, undeclared effects, invalid inputs, missing receipts, and revoked
  dependencies; no execution or trusted reuse from a bare model success claim.
- Abort acknowledgement versus confirmed termination; live descendants, delayed
  effects, stale generations, expired leases, unresponsive workers, unknown remote
  effects, and disjoint-work claims lacking isolation evidence; role/permission
  mismatch, artifact-only writes, missing epoch evidence and false Git-status
  assurance. Include a proven isolated replacement and permitted unrelated work.
- False milestone completion, changed verifier/dependencies, equivalent failures
  with different prose, expected waits, replan loops, immutable original budgets,
  observer outages, and worker attempts to rewrite observer findings or criteria.

## Effectiveness and cost measurements

Use a labeled synthetic task set with required/recommended/irrelevant skills and
known decision dependencies. Compare legacy routing, explicit-name activation,
and graph-linked selection under identical fixtures. Record:

- Required-skill recall before the decision; unnecessary activation rate.
- Number of user reminders and repeated diagnostics without changed conditions.
- Correct/incorrect/unknown impact decisions when new knowledge arrives.
- Complete instruction bytes, total context estimate, omitted objects, and model
  calls attributable to routing or retries.
- Warm/cold selection latency, verified artifact reads, durable writes, memory, and
  index rebuild time at 100 and 1,000 skills with unrelated history present.
- Citation validity and evidence classification; unique source lineage rather than
  the number of repeated summaries; correct stale/conflict/unknown classifications.
- Incremental reuse ratio, model calls/request bytes per accepted unit, total job
  cost uncertainty, invalid-output retries, and committed work retained after faults.
- Invalidation latency, pending frontier size, source-to-decision impact precision
  and recall, index recovery cost, and disk growth under a bounded event workload.
- Run update delivery lag and omitted backlog, duplicate effort, handoff latency,
  helper reuse/rejection, verified milestones, stop-confirmation latency, unresolved
  effects, replacement decisions, and observer false alarms/missed seeded faults.
- Total work per verified milestone, including unsuccessful attempts, diagnostics,
  compactions, helper validation, compilation and observation. Separate cached and
  uncached input, output and other provider-reported categories when available;
  otherwise mark them unknown. Byte estimates are not billed tokens or cost.
- Legitimate safety blocks versus false blockers, scoped blocked operations versus
  unaffected work continued, and retained unknown usage from old workers alongside
  replacement cost. A higher completion rate cannot excuse unsafe replay.

Use a paired ablation with identical synthetic sources, tasks, injected child
outputs, and budgets: current explicit-name activation; proactive routing alone;
then routing plus compilation and invalidation. Do not credit the compiler for
improvements caused only by better routing. Exact-match labeled fixtures require
all mandatory skills before decision commitment and zero unjustified required-skill
activations. Semantic candidate recall is measured separately from enforcement.

For coordination, compare private-only and policy-enabled run sharing with the same
task graph, scripted event schedule and budgets; separately compare observer off/on
and helper reuse off/on. Include the preparation and validation cost of helpers.
Measure safety and overhead even when a scripted provider cannot demonstrate a
model-quality benefit. Paper results are not ALG baseline or ablation evidence.

The first end-to-end fixture must require zero user skill reminders, preserve every
committed independent unit under injected faults, expose every declared coverage
hole, and identify all labeled affected decisions without marking unrelated ones
invalid. Report mistakes as well as abstentions. A source-backed but incorrect
interpretation is still an error, not a successful citation test.

Deterministic safety fixtures require zero unauthorized visibility, clipped required
instructions, or stale-receipt dispatches. Record latency and activation baselines
before setting a regression threshold; existing memory benchmark results are not
performance evidence for this feature. Model effectiveness requires a separately
authorized evaluation and must not be inferred from synthetic parser/adapter tests.

## Local long-horizon acceptance profiles

Freeze the build, configuration, fixture seed, workload schedule, event/byte quotas,
memory/disk ceilings and time budget before each run. Use synthetic repositories,
APIs and external-effect simulators with injected child responses; no production
credentials, paid provider calls or GitHub runners. A clock-advanced test checks
transitions, not elapsed endurance. Host-adapter checks are reported separately from
fake-host coverage and are required before claiming supported-host integration.

| Profile | Required workload | Claim permitted |
| --- | --- | --- |
| Fast fault suite | Deterministic permutations of every declared crash, cancellation, scope, delivery and invalidation boundary; virtual time allowed. | Transition and recovery behavior on the enumerated fixtures only. |
| Initial local soak | At least 60 minutes actual elapsed time, four synthetic workers, at least 20 compactions per worker, three controller/host-simulator restarts, and 1,000 meaningful committed transitions across active tasks. | One-hour local synthetic endurance on the measured configuration. |
| Extended opt-in soak | At least 24 hours actual elapsed time, four synthetic workers, at least 100 compactions per worker, eight controller/host-simulator restarts, and 10,000 meaningful committed transitions across active tasks. | 24-hour local synthetic endurance on the measured configuration; not live-provider or production reliability. |

Run a recurring mix of dependent work, independent branches, legitimate waits,
source/API changes, shared findings, helper drift and verifier-backed milestones.
Inject revoked membership, reordered/duplicate events, stop timeouts, late results,
unresolved effects, false completion, repeated known failures, and observer outages.
Count meaningful state transitions separately from polling, heartbeats and repeated
no-op reads; idle wall time alone cannot satisfy a profile. Persist wall-clock and
monotonic elapsed receipts, active/idle/recovery time, injected-event counts, exact
completed milestones and all remaining gaps. A crash or restart never resets totals.

Acceptance requires zero seeded scope leaks, false verified completions, stale-owner
publications, or conflicting replacements while covered effects remain uncertain.
Every injected required-input invalidation must be reconciled before dependent
dispatch. Preserve every valid independently committed output and every unresolved
effect through restart. All model-call/byte/time limits remain enforced, and every
resource quota exhaustion is explicit rather than silently evicting required state.

Report delivery and recovery latency distributions, backlog, blocked-safe outcomes,
verified milestone throughput, memory high-water mark, disk growth per committed
transition, and total failed/accepted work. Compare latency and resource use with
the umbrella increment 0 baseline under the same schedule; freeze regression ceilings before
acceptance and do not change them to fit a result. Synthetic tests report measured
bytes/calls, not fabricated monetary savings. Any later authorized live evaluation
must report all provider usage, cache categories and unknown cost separately.

An integrated release claiming the long-horizon coordination capability requires
the fast suite and one-hour soak. Earlier independently shipped increments use
their own declared acceptance scope and do not wait on the compiler or watcher. The 24-hour
profile is a separate explicit run, required before any 24-hour claim, not an
automatic background job. This specification authorizes neither execution now nor
an inference of multi-day reliability from shorter successful tests.

## Delivery boundaries

The umbrella's V1 Phase 1 delivers procedure continuity and context visibility.
None of this contract's new sharing, observer, watcher or replanning features is a
prerequisite. Use only the applicable continuity fixtures for that phase; the full
coordination matrix and long-horizon profiles belong to their later enabled slices.

Run sharing can ship with existing validated findings before semantic compilation.
Verified milestone inspection can ship before automatic replanning. Read-only
observer findings can ship before scheduled watch admission. Every enabled path
uses the same existing run authority, diagnostic envelope and budget ledger.

The full end-to-end scenario above is the program integration gate, not a claim
that every early increment needs every later feature. Each local report binds its
enabled capabilities and omitted coverage. V2 adapter conformance and live-model
effectiveness remain separate from synthetic state-machine coverage.
