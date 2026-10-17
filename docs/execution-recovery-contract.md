# Execution and recovery contract

Status: Draft component contract, 2026-10-17. Part of
[durable operational context and execution](skill-knowledge-graph-design.md).
These are implementation requirements, not currently supported configuration.

This contract owns work identity, attempts, host bindings, effect reconciliation,
budget accounting, failure dispositions and legal plan revisions. The current
delivery targets V1; a future V2 adapter will reuse this contract. The V1 adapter,
incident watcher and compiler use it; none owns an alternative recovery
state machine. Existing run/store authority and immutable history remain in place.

## Inputs outputs and ownership

The executor accepts an authorized work item and a versioned plan, and returns
committed attempt outcomes, evidence references and remaining work. Host adapters
supply observations and capability receipts, not permission to skip core checks.
The run store owns the work item, plans, attempts, assignments and execution ledger.

A work item survives a conversation change; a session is an interaction/host
binding, not the identity of the objective. The first implementation uses a run
as the work item. A later continuation may reference that work item explicitly;
equal goal text, filenames or incident fingerprints never merge work automatically.

Illustrative shape, with symbolic digests rather than production identifiers:

```ts
type WorkItem = {
  id: string; project: string; objectiveRef: Ref; criteriaRef: Ref;
  planRevision: Ref; ownerRef: Ref; authorityRef: Ref; budgetRef: Ref;
  status: "planned" | "running" | "blocked" | "done" | "failed" | "cancelled";
  continuationOf?: Ref;
};
type AttemptBinding = {
  attemptRef: Ref; generation: number;
  host: { adapter: string; instance: string; databaseEpoch: EpochEvidence };
  sessionID?: string; promptID?: string; launchRequestDigest: string;
  admission: "reserved" | "dispatch_unknown" | "admitted" | "terminal";
  execution: "unobserved" | "running" | "terminal" | "unknown";
  effectScopeRef: Ref; effectState: "none" | "settled" | "unknown";
  stopReceiptRef?: Ref; terminalReceiptRef?: Ref;
};
type EpochEvidence =
  | { state: "verified"; value: string; evidenceRef: Ref }
  | { state: "unverified"; candidate?: string; reasonCode: string }
  | { state: "unavailable"; reasonCode: string };
```

`Ref` uses the exact cross-store address in the
[knowledge contract](knowledge-environment-contract.md#cross-store-references).
Admission, execution, effect state and cancellation are independent dimensions:
a terminal response can be schema-invalid while its effects are still unknown.
Here `host.instance` identifies the durable host installation/service domain, not
its process ID. Track process generation separately. A verified restart of that
domain and database epoch can reconcile an old binding; a reset or unprovable
epoch transition remains unknown.

### Host identity evidence on V1

The V1 adapter must report the source and coverage of epoch evidence, not assume
the host exposes a database epoch. `verified` requires a supported identity source
and conformance evidence covering database replacement/reset. A stable endpoint,
process ID, file timestamp, database pathname or an ALG-generated UUID does not
establish that continuity. Keep ALG store identity separate from host identity;
do not bypass host access controls to inspect its database.

Compare epoch evidence across observations. Missing evidence or a suspected reset
is unresolved continuity, never a fabricated replacement epoch or proof of no
admission. Match a recovered positive result through supported provenance and the
exact binding; require verified epoch/absence semantics for any negative-lookup
shortcut. Without them, an absent result remains unknown.

Unavailable epoch evidence blocks only transitions that depend on proving host
continuity or absence. It does not prohibit inspection, context restoration, a
provably never-dispatched reservation, or newly authorized work whose effects are
demonstrably non-conflicting. These paths must still satisfy their other authority,
budget and identity checks. Phase 1 continuity needs no host database epoch.

## Reconciliation before dispatch

Reserve an attempt and charge its budget before launch. Persist caller-chosen IDs
only where host conformance establishes their semantics; otherwise record the
creation receipt and preserve uncertainty across an unrecorded-create crash.
Deterministic IDs alone do not make an API idempotent.

| Observation | Permitted transition |
| --- | --- |
| Durable evidence proves the launch was never dispatched | Dispatch under the reserved attempt and current authority. |
| Host proves no admission for the exact request in the same intact instance/database epoch, with tested idempotency and absence semantics | Admit or recover that exact request within budget; no new worker identity. |
| Session or request missing, but absence semantics or epoch continuity are not proven | Record unknown outcome; do not infer that nothing ran. |
| Matching worker is live | Attach/observe; no conflicting replacement. |
| Matching terminal response exists but was not locally committed | Recover, validate and commit its response outcome once; separately persist effect uncertainty and gate conflicting continuation. |
| Worker terminated but external effects are unknown | Preserve terminal evidence; block conflicting replay/replacement pending reconciliation. |
| Host unavailable, identity changed, or observation incomplete | Block conflicting dispatch and retain the original uncertainty. |

Apply this on resume, reload, takeover, cancellation and explicit retry on both
hosts. A stale ledger entry marked running is not proof of liveness or death.
A lookup must bind project, host instance/database epoch, session, prompt and
attempt, preserving unavailable evidence rather than guessing its value. A response
from another instance cannot settle an old attempt.

Example: an API write was admitted, the controller crashed, and the host session
was subsequently deleted. The missing session does not authorize another write.
Reconcile the operation ID with the API or use an already-enforced idempotency
contract. Otherwise expose a blocker and preserve unaffected completed work.

## Cancellation and safe replacement

Treat cancellation as a protocol rather than a Boolean. The current
[child-stop helper](../src/sessions.ts) requests abort and waits for a bounded
period; a successful request or resolved Promise alone is not evidence that all
effects have stopped. Add a durable lifecycle receipt alongside each child attempt.

| Lifecycle fact or decision | Required meaning |
| --- | --- |
| `running` | A child has been dispatched; separately timestamp liveness observations rather than inferring them from saved state. |
| `cancel_requested` | A durable stop request identifies the child, execution generation, and declared effect scope. No conflicting replacement may dispatch. |
| `termination_confirmed` | The adapter supplies authoritative evidence that the child and covered descendant execution have stopped. This says nothing about success or already-issued side effects. |
| `termination_unknown` | Confirmation is absent, insufficient, or timed out; retain affected-resource uncertainty and the unreconciled receipt. |
| `safe_to_replace` | Current evidence proves termination or enforced isolation, and outstanding effects have been reconciled or are safely deduplicated within the declared replacement scope. |

These facts do not overwrite the response outcome. `safe_to_replace` is a derived
decision over current receipts, scope and authority, not a replacement for the
historical cancellation, termination or effect records.

Assign a monotonically increasing execution generation to an ownership slot within
the run. Covered dispatches and result publications validate that generation and
the current fence. Late results from a replaced generation remain auditable but
cannot advance current state. A stale generation must be rejected at the actual
effect boundary where the adapter supports it; rejecting a result after an external
write is not execution fencing.

Require a host capability declaration and conformance test for stop confirmation,
descendant cancellation, dispatch fencing, resource isolation, and external-effect
reconciliation. Do not claim support from an SDK method name. A run-file lease can
serialize ALG writes but cannot stop unrestricted child shell/API activity. If a
worker can affect unknown resources, use a conservative conflict scope and report
that limitation rather than claiming complete coverage.

On cancellation or controller restart, inspect unsettled attempts before dispatching
new conflicting mutations. Request stop through the supported host adapter and
reconcile within a bounded timeout. If uncertain, retain `termination_unknown` and
withhold conflicting replacements. Independent work may continue only when its
effect scope is demonstrably disjoint and existing permissions allow it. A fresh
workspace alone does not isolate remote API/database effects.

External actions need their own durable operation IDs, idempotency receipts, or
read-only reconciliation where available. Unknown actions are not replayed just
because their worker has stopped. A recovery action that kills processes, changes
permissions, rolls back data, or expands the original authority requires separate
operator approval unless an explicit preapproved policy already covers it.

Cancellation intent is monotonic. A delayed success response cannot clear it or
silently resume the plan. A terminal result proven to precede cancellation may be
retained as evidence under its original attempt, but dispatch after cancellation
still requires an explicit resume and fresh preflight. Never refund charged calls
or reset deadlines during replacement. Preserve original failure and lifecycle
receipts through migration, restart, and retry.

### Capability based effect scopes

An agent role proposes a default profile, not a replay permission. Persist the
effective permissions, tool/connector identities, resource scope and enforcement
evidence with the attempt. Include custom tools, MCPs, permitted artifact writes,
descendants and remote operations; a prompt saying "read only" is not enforcement.
Permission or tool-set drift invalidates the old scope receipt before reuse.

The present researcher permits run-artifact writes and the implementer permits
shell execution. Explorer/checker edit and shell denials alone do not prove that
every additional tool is harmless. Validate the actual installed permission set.

| Proven capability and scope | Recovery path |
| --- | --- |
| Effect-free observation with enforced denial of mutations and isolated result publication | A bounded replacement may proceed without a termination claim if continued old execution cannot interfere, duplicate reads are allowed, and both executions remain budgeted. Revalidate mutable inputs. |
| Writes confined to an enforced attempt-private artifact/workspace scope | Replacement needs proven termination or isolation from the old writer; validate retained artifacts before publishing or merging them. |
| Declared remote effects with tested idempotency or operation receipts | Reconcile the exact operation and resource, then apply the shared replacement predicate; a new workspace is not remote isolation. |
| Unrestricted shell, undeclared tools/resources, or missing enforcement evidence | Keep a conservative conflict scope and unknown effects; no role-based automatic replay. |

Requesting stop alone never authorizes replacement. `git status` is useful evidence
about some current files, not a complete effect audit: it misses ignored files,
external writes, running descendants and future writes. Combine scoped filesystem
reconciliation with the necessary termination/isolation evidence; never automatically
reset or discard the user's working tree as a recovery technique.

Block only affected conflicting operations where scope is known. Unrelated work
may proceed with proven separation and sufficient remaining budget; an unbounded
effect scope must not be narrowed merely to avoid a blocker. Retain unknown usage
and reservations for a still-running old attempt while charging any replacement.
No parallel retry may create unbounded orphan workers or exceed enforceable caps.
Measure legitimate safety blocks and false blockers separately from task failures.

## Selective continuation and workload sizing

Existing `prepareRunForResume` retains done nodes and existing attempts; successful
siblings are already persisted. The gap is safe continuation when the old graph,
attempt cap or task size prevents progress, not a requirement to invent persistence.

A continuation proposal binds the old plan and exact retained outputs, identifies
the failed or incomplete unit, and names only the needed changes. The executor:

1. Reconciles in-flight execution and effects before permitting replacement.
2. Revalidates each retained output's source, artifact, verifier and dependency
   revisions. Keep unrelated valid nodes done; mark only affected work stale.
3. Validates revised dependencies/cycles, criteria, operation scope and remaining
   budget before committing a new plan revision.
4. Preserves attempts and superseded plans. An exhausted budget blocks continuation;
   more spending requires explicit new authority with cumulative lineage, not an
   automatic fresh run that hides previous cost.

Task sizing is part of planning, not a promise to predict exact model steps. Record
the effective host step ceiling when knowable, the work chunks, required final
artifact, expected verification work, and a wrap-up reserve. When the host exposes
step progress, request checkpoint/finalization before the reserve is exhausted.
Otherwise decompose conservatively and report that step enforcement is unavailable.
An arbitrary tool-call count is not a portable measure of a host step.

A known step-limit outcome is `workload_incomplete`, not proof of malformed JSON.
An empty response without trustworthy termination evidence remains
`empty_output_unknown`; do not guess it exhausted steps. A saved patch or artifact
can support continuation but is not a passing node without its required verifier.
A bounded output-only repair can reuse a known terminal result only under an
approved repair path that cannot repeat implementation effects or weaken its gate.

## Failure taxonomy and budget ledger

Use a versioned, schema-owned diagnostic envelope shared by executor, compiler,
watcher and observer. It carries `code`, `stage`, `attemptRef`, `evidenceRefs`,
`retryDisposition`, `effectState` and safe fixed fields. Domain payloads may extend
it through explicit schemas; no raw error text or unknown key name becomes policy.

| Category | Examples | Default disposition |
| --- | --- | --- |
| Extraction or output contract | no JSON, truncation, schema violation | Known terminal invalid result: bounded informed retry/repair, after effect checks. |
| Gate configuration | invalid shell dialect/path/command | Correct the plan before another worker; no blind reimplementation. |
| Workload incomplete | confirmed step ceiling, required artifact unfinished | Checkpoint/decompose or explicit bounded continuation. |
| Quality rejection | a real test or checker criterion fails | Route evidence-backed feedback within original authority and budget. |
| Transport or authentication | adapter-classified unavailable provider or denied authentication | Bounded infrastructure policy; may open a watcher breaker. |
| Unknown execution or effects | lost admission, missing session, unresolved write | Reconcile; do not convert uncertainty into an ordinary retry. |

Keep parser reasons and schema validation separate from claims about their cause.
A parse failure alone does not prove stochastic model noncompliance. Preserve
legacy outcome labels as historical data rather than rewriting their meanings.

One durable ledger accounts for initial attempts, model/provider retries where
observable, repairs, compilers, observers, host restarts and continuation work.
Keep these categories separate, but charge all attributable usage to the same
approved budget lineage. Record unobservable usage as unknown; never refund it.
Host automatic resumes need a tested cap/stop boundary before unattended operation.
A host resume is not an ALG attempt, but is not free work or unlimited authority.

## Host capabilities and permissions

One versioned descriptor is owned by this contract and populated by each adapter:

```ts
type CapabilityReceipt = {
  capability: string; adapter: string; hostVersion: string; sourceRevision: string;
  state: "verified" | "unsupported" | "unverified";
  scopeRef: Ref; testedAt?: string; conformanceReceiptRef?: Ref;
  limitations: string[];
};
```

Capabilities include admission/idempotency, observation/absence semantics, stop and
descendant coverage, effect fencing, exact permissions, command-specific approval,
host/database identity evidence, operator-confirmation provenance, step telemetry,
current-request inspection and historical transcript coverage.
Source/types support a probe plan, not a verified runtime receipt. Configuration
may enable only capabilities established for that feature's actual boundary.
A worker never waits indefinitely for interactive approval; unsupported required
capabilities block that feature with a typed reason, not an unrestricted fallback.

Context and knowledge consume this descriptor; the V2 table is a view of it, and
the watcher adds requirements to it rather than creating a second table. Host tool
permissions remain authoritative even when a graph record or approval exists.

## Migration and local acceptance

Apply the shared additive attempt-binding format to V1 first. Future V2 support
must reuse it, but a V2 migration is not part of this delivery. Preserve
legacy bytes; missing epoch, stop or effect evidence remains unknown. Readability
does not grant cross-host execution. Transfer ownership only after reconciliation,
current permission checks and a fresh fence; closing a run never proves stop.

Required V1 local cases: cancelled-but-live worker; controller restart; deletion or
database reset after dispatch; crash before/after admission and commit; delayed
effects; stale generation; unknown usage; exhausted budget; intact completed
siblings; step-limited partial artifact; changed prerequisite; and graph revision
with a cycle or weakened criterion. Also cover unavailable epoch evidence, reset
with the same endpoint, forged local epoch IDs, role/permission disagreement,
artifact-only writers, custom remote tools, ignored-file writes, late writes after
a clean Git status, proven isolated replacement and continued disjoint work.
Charge old and replacement workers together under the unchanged ceiling.
Simulators establish core transitions;
installed-V1 checks establish adapter coverage. V2 native-recovery and adapter
cases belong to the deferred V2 work and cannot block V1 acceptance. No GitHub
runner tests.

This contract implements umbrella increment 0a and is required before automatic
replacement, autonomous continuation or scheduled watcher takeover. Skill
visibility and read-only context improvements can proceed independently.
The umbrella's V1 Phase 1 does not enable these new replacement/continuation paths
and is not gated on completing this contract's full lifecycle implementation.
