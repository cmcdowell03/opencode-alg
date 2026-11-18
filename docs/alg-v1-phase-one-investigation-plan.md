# ALG V1 Investigation Review and Phase One Plan

Design review and proposed implementation sequence. Dated 9 November 2026.

The first V1 milestone combines workspace readiness with durable investigation recovery: the harness resolves the procedures and facts its action requires, then retains evidence and search state through compaction or restart without automatically repeating completed or possibly running work. Qualify datalake-mcp before deciding what orchestration state it lacks; reuse ALG's executor, memory and persistence.

This reviews the [applicability and measured improvement spec](alg-v1-applicability-measured-improvement-design.md) and [large data investigation spec](alg-v1-large-data-investigation-design.md). It follows the [shared design index and roadmap](alg-v1-design-index.md), reconciled with the companion drafts after Claude's review. This paragraph records the original design review; implementation was subsequently authorized and is tracked in PR #14. See [implementation status](v1-implementation-status.md) for delivered and deferred contracts. No V2 work, production queries, model evaluations or GitHub runner tests were performed for this review.

## Verified baseline and integration assumptions

GitHub main was checked on 9 November 2026 and remains [99b88cd](https://github.com/cmcdowell03/opencode-alg/commit/99b88cd051cdff2ac30eff81b5a927d76a826efe), the baseline named in both designs. Implementation findings below use pinned source from that commit.

datalake-mcp's FastMCP, Polars, DuckDB, Arrow, Parquet/S3 and incomplete evolving knowledge-map capabilities are user-described. Its actual tool schemas, caller identity, submission idempotency, job lookup, cancellation, retention and map-update guarantees have not been inspected. Phase One must qualify those contracts rather than infer them from the framework or tool names.

## Gaps that matter before implementation

| Priority | Gap | Required resolution |
| --- | --- | --- |
| Blocking | Generic ALG resume can reopen interrupted nodes; neither spec defines how remote jobs are reconciled before that happens | Place an investigation reconciliation guard before resume and every managed query dispatch. Reuse results, reconnect to jobs, or block an ambiguous submission |
| Blocking | A shared query ledger is described without exact identity or crash transitions | Define a work identity separately from a submission identity, a fenced admission transaction and explicit unknown-outcome behavior |
| Blocking | The MCP invocation path is unspecified | Qualify an actual call adapter. Existing ALG does not provide universal MCP interception; direct calls outside the managed path cannot inherit its deduplication guarantee |
| High | Session checkpoints and investigation state have different lifetimes | Persist the investigation independently of conversational summaries, then attach session checkpoints by a typed reference. Explicit task changes must not silently erase or restart the investigation |
| High | Map revision, source freshness and query-result validity are conflated | Track dependencies separately. New unrelated map knowledge should not invalidate a valid result; a changed relevant join, source or permission must trigger scoped revalidation |
| High | Reusing existing stores could exceed their bounds | Keep the 11,000-table map and bulk results in datalake-mcp. Store bounded investigation records and evidence references; reserve storage for terminal receipts before dispatch |
| High | Existing incident labels and strict child schemas do not express the proposed causal guarantees | Add typed investigation evidence artifacts without weakening child schemas. Keep execution completion, analytical outcome and remediation state separate |
| High | Realtime map learning could accidentally become a second publication mechanism | Use existing MCP update semantics when qualified and authorized; otherwise retain proposals. Skill promotion and executable-helper deployment remain distinct |
| Sequencing | Both specs include much more than the first reliable workflow needs | Deliver workspace readiness and deployment qualification, then a fixed investigation graph and recovery. Measured skill promotion, artifact-pack qualification and recursive graph authoring remain subsequent milestones |

The gaps are mainly missing integration and recovery contracts. They do not justify a new database, query engine, hosted service or scheduler.

## Reuse map

| Existing component | Reuse | Small extension needed |
| --- | --- | --- |
| SessionMemoryRuntime, MemoryStore and ContextDelivery | Durable task bindings, exact approved skills, revision checks, bounded context assembly and delivery observations | An investigation reference and bounded context projection; reconstruction at ordinary request preparation as well as compaction |
| alg_plan, templates and executor | Fixed DAGs, child roles, attempts, dependencies, run locks and progress | One investigation template, registered work orders and a reconciliation guard before investigative resume |
| Run store, persistence and filesystem mutex | Contained paths, immutable artifacts, atomic publication and fencing | Typed investigation records and one mutable head managed through the same primitives |
| Experience and troubleshooter | Supporting/refuting relations, immutable observations, incident history and explicit remediation authority | Publish verified milestone evidence and link the investigation; do not reinterpret legacy incident labels as causal proof |
| Existing skill approval, load and preflight | Exact procedure revisions and configured application approval | Register the limited investigation operation scope and its required facts and checkpoints |
| datalake-mcp | Existing map, data access, Polars/DuckDB computation, Arrow/Parquet results and any existing job API | A narrow ALG adapter and capability receipt; server changes only for demonstrated missing guarantees |
| Existing status and CLI surfaces | Inspection and explicit recovery | Show search reuse, pending jobs, coverage gaps, missing skills, analytical status and remaining budget |

ALG's system-transform and compaction hooks already assemble context. Its runtime explicitly reports universal tool interception as false and supports alg_run/alg_resume adapters. These are the integration points, not a promise that every MCP call is already covered. [Hooks](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/index.ts#L199), [runtime coverage](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/session-memory/runtime.ts#L201)

## First milestone and deferred work

Phase One has one outcome: the harness knows the workspace requirements for its current action and can continue a bounded investigation without repeating verified work. The [design index](alg-v1-design-index.md) owns its single sequence.

Phase 1a combines baseline visibility, the shared workspace requirements registry, and qualification of the actual MCP/model/data boundary. Seed requirements from existing Git, migration-preparation, test and investigation procedures; begin in advisory mode where action coverage is unqualified. Reuse the same applicability matcher and existing skill approval. Qualify the real service and one small permitted model-assisted case before choosing the final service adapter. Local readiness work can proceed while remote access remains unavailable.

Phase 1b adds only the missing durable work admissions, query/result reuse and context projections to a fixed template on the existing graph executor and stores. Reuse existing server-side jobs/idempotency rather than duplicating them. Start with one root coordinator and up to three specialist branches; keep the proposed two-expensive-job cap and finite root budget until measured evidence justifies changes.

Measured promotion waits for real candidate revisions and curated cases. Template selection and parameterization precede free-form graph authoring. Recursive coordinators, live graph mutation, new ML engines, cross-user synchronization and executable-helper deployment remain later work. The user-requested artifact skill remains an optional later extension, not a Phase One dependency.

## Linux/Bash environment and acceptance

Add a dedicated Ubuntu-24.04 WSL 2 environment during Phase 1a, separate from Docker Desktop, using a non-root test user, Linux filesystem and Linux-native dependencies. Pin the OpenCode 1 host and reuse the same ALG revision and fixtures as the Windows lane. The [Linux/Bash acceptance plan](alg-v1-linux-bash-acceptance-plan.md) defines setup, one-command deployment through the existing versioned manager, Bash gate behavior, filesystem and process tests, offline relocation, host/TUI checks and evidence.

The Linux lane is a required Phase One release gate. Synthetic compaction, recovery and duplicate-job assertions run on both platforms. Real host/model evidence remains separately budgeted, and WSL receipts do not establish native-server or container acceptance. No GitHub runners or V2 work.

## Service and model qualification gate

Produce a capability receipt from the actual deployment: callable tool schema revisions, identity and permission scope, job lookup/idempotency, cancellation meaning, limits, source revision semantics, map-update authority and result lifetime. These observations determine how much ALG code is needed. A bounded local fake is for contract mechanics, not evidence about the deployed service.

Add the workspace's allowed data/model profile before any live probe: execution endpoint, model/runtime, permitted metadata and result classes, transcript/telemetry retention, and filtering performed before model exposure. Use synthetic or explicitly approved data. Unknown policy blocks the live path without blocking local registry and recovery development.

One small independently budgeted probe checks the actual model's tool use, output adherence and ability to retain the task. Do not estimate its cost or duration from other deployments. If access is unavailable, supply an operator-runnable qualification recipe and leave live acceptance open. No probe, paid call or production access is authorized by this document alone.

## Authoritative state and storage contract

Use one investigation identity independent of prompt text and session-summary text. Its root execution remains an existing ALG run. Add an explicitly versioned reference from the run and from attached session checkpoints; preserve old schemas and histories, and reject unsupported future variants rather than silently parsing them as legacy state.

The scheduler continues to own node and attempt state. A focused investigation ledger owns search coverage, work orders, query admissions, jobs, hypothesis references and MCP budget reservations. Manage that ledger as typed records under the root run's existing contained artifact/history storage, with one revision-fenced head and the existing persistence primitives. It is not a second DAG scheduler. Freeze exact paths and schema versions in the first implementation change.

Write immutable records first, then advance the authoritative ledger head. The head binds object digests, expected revision and budget changes in the same local transaction. Session context, status views and experience summaries are projections that can be rebuilt. A crash after committing evidence but before updating a session checkpoint must not lose the evidence or cause resubmission. A proposed record not reachable from a committed head cannot authorize dispatch.

Do not put operational state into freeform summaries or undeclared ExperienceSchema fields. The existing experience envelope is strict, capped at 32 KiB per object and 10,000 objects; its archival copy does not reset capacity. The existing session checkpoint is also strict and bounded. Use small typed investigation records with existing byte and file quotas, and publish selected milestone evidence into the experience store. Retain map pages and bulk results remotely where their retention contract permits. [Experience schema and bounds](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/experience.ts#L17), [checkpoint schema](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/session-memory/schemas.ts#L107)

Before admission, reserve bounded space for the submission receipt, a terminal receipt and head advancement. Refuse new work when that reserve cannot be maintained. No eviction of active job or reuse evidence, automatic quota increase, or record per unrelated catalog table. Measure actual object and byte growth in the acceptance fixture. Storage or integrity failure produces a visible recovery blocker.

## Managed MCP dispatch and request identity

Expose one narrow investigation work surface rather than a new tool for each table or record. Its query action accepts an admitted work-order ID and typed parameters, not an unconstrained instruction to search the whole lake. Status/result actions do not submit new work. Reuse an existing callable host/service route if it supports the contract; otherwise implement the smallest configured client adapter to the existing datalake-mcp service. Do not add a second MCP server or claim a host dispatch API that has not been verified.

The adapter must establish the exact server/tool schema revision, caller/project scope, allowed effects, response bounds, available job operations and credential-reference handling. Keep credentials out of persisted keys and messages. Qualify the route before advertising live support. Restrict the first analytical surface to reviewed tools or parameterized recipes; arbitrary SQL equivalence and arbitrary Python execution are outside its reuse guarantee.

Use two different identities:

- Work key: a versioned canonical hash of project/principal scope, server and tool semantics, admitted operation and recipe version, normalized typed parameters, cohort, requested as-of window, source snapshot dependencies and preprocessing revision. Equivalent callers for this admitted work share the key. An intentional independent verification or refresh gets a separate recorded purpose and generation.
- Submission identity: a stable operation ID persisted before crossing the network boundary, and sent as an idempotency key when the server supports it. Reconnecting after a timeout retains this identity. A fresh ID is never minted merely to escape an uncertain result.

Skill and map revisions remain in provenance. A new unrelated map edge or skill wording change does not by itself change a computation's work key. A changed resolved dataset, join recipe, transformation or authorization changes validity or request identity. Parameters with ambiguous normalization remain distinct; never assert semantic equivalence of arbitrary SQL by removing whitespace or comments.

Equivalent calls are coordinated under the existing fenced lock primitive. A second caller attaches to the committed admission or result. Hold the lock only for local state changes, not for the duration of a network query. A lease expiring does not prove the remote job stopped. Only a current fence holder may advance authoritative state; late callbacks cannot overwrite a reconciled outcome.

## Submission and recovery state machine

| State | Permitted next action |
| --- | --- |
| Reserved | Scope, quota and work identity are durably admitted; commit dispatch intent before contacting the server |
| Submitting | Submission identity is committed; obtain or reconcile the remote job/result. After a crash this state is ambiguous, not permission to send a fresh request |
| Running | Persisted job identity is known; bounded polling, result retrieval or cancellation request only |
| Result recorded | Store the immutable result manifest, integrity/provenance and coverage; finish local validation without rerunning the query |
| Reusable | Serve the retained result after validity and access checks; record reuse without charging a new analytical job |
| Failed known | Retain failure and usage. Retry only under declared policy, with a new recorded attempt and remaining budget |
| Outcome unknown | Reconcile by submission key/job identity. If the server cannot resolve it, block the affected work instead of automatically replaying it |
| Cancel requested | Retain the reservation while compute may remain live; release only under the qualified terminal-state contract |
| Unavailable or stale | Preserve history and explain why reuse is unavailable. A new compute request requires an explicit admitted refresh or recomputation reason |

The key crash window is remote acceptance before local job-ID persistence. A server lookup or idempotent submission contract can close that window. An ordinary missing-job response cannot prove nonexecution if jobs expire or lookup is incomplete. Without a server guarantee, ALG can promise no automatic duplicate submission by blocking uncertainty; it cannot promise both exactly-once execution and uninterrupted progress.

Integrate reconciliation before prepareRunForResume reopens investigative work and repeat the check inside managed dispatch. Existing resume logic converts interrupted running attempts into failures and may make the node pending again. A restarted worker must recover the same work order and query identity even if its model response or final schema failed after a successful query. Completed sibling evidence remains accessible when the run fails. Do not change unrelated legacy graph retry semantics. [Current resume behavior](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/executor.ts#L573)

Model-call limits remain enforced by the existing executor. MCP admissions and usage have one ledger authority. Status combines those views without resetting either counter after compaction, attach, retry or follow-up planning. Unknown cost or still-running work retains its reservation; output row limits do not substitute for enforced scan or time limits.

Detaching or deleting a chat does not delete the investigation ledger or prove that its jobs stopped. Apply the configured cancellation policy, preserve pending cancellation records and prevent new admissions for the detached owner. Server-enforced deadlines must bound unattended work if the OpenCode process disappears. Resume or authorized attach reconciles those jobs before reusing their resource slots.

## Result validity and incomplete search coverage

For discovery requests, include the scoped map revision or observed interval, filters, page cursor, visibility and coverage in reuse decisions. Preserve the frontier and negative results so a resumed session does not repeat a fruitless lookup. A negative result applies only to that searched scope; a relevant map revision can reopen it.

For data requests, prefer immutable source versions or pinned snapshots. When only mutable sources are available, distinguish reuse of an explicitly historical observation from a new request for current data. A TTL alone does not prove source equality. Cheap metadata validation may establish freshness; if it cannot, return stale or unknown and propose a bounded refresh. Do not launch an expensive refresh merely because context compacted or a timer elapsed.

Pin the exact result manifest, source versions or read interval, transform, row count, schema and returned coverage. A live handle is not durable evidence unless its retention or an authorized immutable copy is sufficient. A retention-aware materialization through existing datalake-mcp Parquet/S3 tools is preferable to silently rerunning a lost result. Detect expired handles and changed permissions before exposing cached data. Phase One reuse is project/principal scoped, not a cross-user cache.

Map improvements retain before/after revisions and verification status. Recheck only dependent joins, identities, claims and search frontiers. Inference cannot become a trusted join through repeated use, and a map-only update cannot rewrite the evidence behind a completed analysis.

## Compaction and session recovery contract

Commit meaningful state changes when they happen. The compaction hook is a projection boundary, not the only opportunity to save work.

On every normal request preparation, and after restart or compaction:

1. Resolve the attached investigation and verify its owner/project binding and committed head.
2. Reconcile admitted or running jobs before admitting more compute.
3. Restore exact approved skills and validate current prerequisites; retain the existing complete-instruction budget rules.
4. Build a bounded context packet containing objective, scope, active hypotheses, contradictions, tests already performed, search coverage, pending jobs, evidence references, required checkpoints and the next permitted action.
5. Check the same authoritative state again at managed dispatch so a missed hook or stale model context cannot bypass reuse.

The full query ledger and data remain outside prompt context. On overflow, expose an explicit needs_context state instead of clipping required procedures. Context delivery observations remain request-bound; they are not proof of the model's internal understanding or proof that the host consumed text.

Current beginTask increments the task epoch and clears skills, pins and other task state. Add explicit begin, continue, attach and detach semantics for the investigation reference. Compaction and the word continue never create a new investigation. A genuinely new task may detach a session while preserving the prior investigation and its jobs. A different session attaches only through an authorized project/owner transition; inability to verify ownership is a blocker, not a reason to copy the state into a new investigation. Child work inherits read/reference access and narrow work orders rather than root approval powers. [Current task lifecycle](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/session-memory/runtime.ts#L34)

## Evidence and existing child contracts

Keep current researcher and checker output schemas. Workers return valid ResearchOut summaries with evidence paths; authoritative hypotheses, queries and results live in typed artifacts written or checked by the managed adapter. Resolve referenced evidence through owned, contained paths before accepting it. No new ad hoc JSON properties in strict child responses and no fake shell gate for an MCP analysis. [Child schemas](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/schemas.ts#L308)

Separate three outcomes: the DAG completed its required work; the analytical result is supported, contradicted, unresolved or blocked; and an operational incident has or has not been remediated. A checker can accept an honestly unresolved report when the criteria require correct uncertainty. It cannot turn a failed infrastructure operation into success by omitting its failure. Infrastructure failures retain failed attempts, while durable evidence and status remain inspectable.

The current troubleshooter requires an observed diagnostic for cause-identified and verification tied to remediation for resolved. Reuse those lifecycle checks, but do not call cause-identified a validated causal finding. Phase One adds an explicit analytical verdict and declared evidence criteria; stronger causal labels require the investigation protocol. No automatic remediation or production experiments. [Incident transitions](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/troubleshooter.ts#L44)

## Implementation sequence

| Change | Concrete work | Exit evidence |
| --- | --- | --- |
| 0 Local platform environment | Provision the dedicated WSL 2 Ubuntu/Bash lane, isolated user and pinned Linux-native tools | Environment identity and readiness receipt; existing Windows setup preserved; plugin tests still recorded separately |
| 1 Baseline and capability qualification | Record relevant skill reminders/repeated work; qualify existing MCP jobs, map and limits; define the deployment data/model profile and bounded probe | Explicit capability and coverage receipt; actual-host probe where access is available, otherwise a visible live-acceptance gap |
| 2 Shared workspace readiness | Add one reviewed workspace requirements registry backed by existing source approval and applicability; seed real operations and fact/document/skill references | The harness identifies missing requirements and restores approved procedures; no self-authorized mandatory rules or unsupported action enforcement |
| 3 Durable admission and reuse | Add only missing ledger records using existing persistence/fencing and server job facilities; reserve budget and receipt capacity | Crash and concurrency fixtures show no extra accepted jobs for equivalent covered requests |
| 4 Context and fixed investigation | Attach session state to durable records, reuse existing context hooks and child schemas, add fixed template and engineer checkpoint | Compaction/restart recovers skills, work and budget; four synthetic incident families produce grounded or honest unresolved reports |
| 5a Single-command deployment | Extend the existing manager with prepared-bundle validation and a thin Bash deploy action; preserve its transaction and rollback rules | A clean offline install, idempotent rerun and compatible upgrade need one command; no manual config edits; exact receipt and honest restart state |
| 5b Local deployment acceptance | Run the shared regression, installation and relocation gates on Windows/PowerShell and Ubuntu/Bash; exercise the qualified V1/MCP route with synthetic data; prepare curated historical cases | Exact identities and remote-submit counts accompany receipts; usefulness claims require separately approved retrospective/live evidence |

Proposed focused modules are investigation/schemas, investigation/ledger, investigation/mcp-adapter and investigation/context. Keep matching, request identity and transition logic pure where possible; inject clock, server port, persistence and capability results. Use the same proposed applicability matcher for workspace readiness, backed by existing skill discovery, approval and context delivery. Integrate through existing index, session-memory, tools/templates, executor and store surfaces. These names are proposals, not files already present.

Qualification precedes committing to service-specific ledger complexity. Work that does not depend on remote capabilities can proceed locally. The configured route must be exercised with approved synthetic data on the target OpenCode 1 host before calling deployment acceptance complete. Collection of real cases starts early through explicitly selected, permission-scoped incident records and user feedback. This does not enable background historical mining or a new always-on transcript collector. Automatic measured promotion and large candidate benchmarks are later work.

## Acceptance matrix and release boundary

Run all tests locally. Instrument accepted remote job starts and query executions, not just model-visible tool-call counts.

| Case | Required observation |
| --- | --- |
| Two simultaneous identical work orders | One admitted remote computation; both consumers receive the same verified result reference |
| Twenty synthetic compactions and two process restarts | Same investigation identity and budget lineage; no extra submissions for compatible completed work |
| Missed compaction hook or stale context | Ordinary preparation restores state; dispatch still consults the authoritative ledger |
| Crash before/after intent, remote acceptance, job-ID save, result save and head commit | Correct reuse/reconciliation; unresolved acceptance never triggers an automatic new submission |
| Worker final JSON fails after its query completed | Retried worker reuses the recorded query result; successful remote work is not discarded |
| Running job and lease expiry; cancellation without terminal acknowledgement | No duplicate submission or premature budget release; stale writers cannot overwrite current state |
| Map gains an unrelated edge | Existing data result remains reusable; only relevant search coverage is reconsidered |
| Relevant join/source/permission change or expired result | Explicit invalidation/unavailable result; no silent cached answer or automatic expensive refresh |
| Empty map page, cursor continuation and later discovery | Negative result stays scoped; frontier resumes correctly and learns newly available coverage |
| Store near capacity, failed write, truncated or corrupt receipt | New work is withheld; last committed state remains usable or clearly blocked |
| New task, authorized session attach, foreign attach | No implicit investigation reset; valid attach retains history; foreign scope is rejected |
| Workspace requirement missing or modified | Scoped readiness gap; explicit source policy; unaffected procedures remain usable |
| Engineer adds conflicting evidence | Contribution has provenance; affected hypotheses are reconsidered; no budget reset or automatic change to verified facts |
| Retrospective case contains later knowledge | Leakage is rejected or the replay is explicitly labeled hindsight-assisted |
| Chamber source, material source, inspection artifact and insufficient evidence | Grounded attribution where supported; unresolved result where evidence cannot discriminate |

Use the proposed 11,000-entry synthetic catalog with a small physical dataset. It measures discovery scale and recovery, not production lake throughput. Keep real time-series analysis and data-quality checks in the MCP's existing tools. Do not implement substitute analytics solely to make the ALG fixture pass.

The deterministic suite establishes mechanics. A separately authorized local OpenCode run establishes model/tool behavior; it records real compactions, interrupted/resumed jobs, exact versions, usage, evidence and remaining limitations. Approval of this design is not a claim that those tests have run.

Phase One is ready when covered requests cannot automatically duplicate compatible completed or unresolved remote work, necessary state and skills survive context loss, the fixed workflow preserves analytical uncertainty, and the relocated package works on both required platform lanes against its declared V1/MCP capability profile. The guarantee covers the managed route and exact supported request identities. Direct unmediated MCP calls, semantic duplicates outside those identities and unsupported server recovery contracts remain explicitly outside it.
