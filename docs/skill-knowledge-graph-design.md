# Durable operational context and execution

Status: Draft umbrella design, revised 2026-10-17. Originally created 2026-10-13
as the skill knowledge graph design; the filename remains stable for existing links.

Original design baseline: main at `f87f6991edd3d98b9f66714def58d457f46eb4f1`.
Implementation target: main including `214d2717c87523aa3dcbaff7c1d04b3ca04a6fb6`.
This design extends existing ALG stores and execution. It does not change runtime
defaults or authorize implementation, deployment, scheduled jobs or live probes.

## V1 delivery scope and deferred V2 work

OpenCode V1 is the implementation and acceptance target for this program. Deliver
the four component contracts through the existing V1 plugin; V1 delivery must not
depend on completing the V2 design, adapter, probes or release process.

Host-neutral interfaces, records and recovery boundaries needed for V1 may account
for future V2 requirements. Build those shared pieces only where they serve the
V1 implementation; speculative V2-only scaffolding is not a prerequisite.

The V2 specification remains unfinished design work. Its implementation phases,
including the phase 0 runtime probe, are deferred until the user finalizes that
design and explicitly authorizes starting V2 work. Do not add a V2 entry point,
SDK dependency, runtime adapter, installer, configuration/database migration or
V2-specific deployment as part of V1 delivery. Shared design compatibility is not
a claim of V2 support. This scope clarification does not start runtime coding.

## Purpose and intended outcome

ALG should continue competent work across context compaction, child delegation,
host restart and environment change. Skill retention is one symptom of a broader
requirement: preserve objectives, justified knowledge, current operating constraints,
valid completed work and unresolved effects without repeatedly rediscovering them.

The durable operational model answers six connected questions:

| State | Question | Existing authority |
| --- | --- | --- |
| Objectives and work | What is the goal, what remains, who owns it, and which results can be reused? | Run store and executor |
| Environment | Which hosts, repositories, APIs, datasets and routes are involved, under which conditions and observation times? | Environment memory |
| Knowledge and procedures | What is supported, uncertain, contradicted, or required to perform the operation? | Evidence/experience and session-memory artifacts |
| Execution and effects | What ran, what changed, and what could still be running or unresolved? | Attempts, host bindings and effect receipts |
| Authority | What is permitted now, by whom, for which principal and operation? | Current host/project policy and explicit approval boundaries |
| Verification | What evidence supports completion, and what changes would invalidate it? | Versioned verifier and source receipts |

The graph connects these authorities; it is neither a complete world model nor a
new executor. Context is a bounded task-specific view of that state. A remembered
route does not grant access, a prior successful query does not prove current data
quality, and a closed worker does not prove its external actions were undone.

For data science, this means preserving dataset grain, snapshot, timezone,
provenance and evaluation assumptions. For troubleshooting, it means retaining
hypotheses, tests already performed, verified resolutions and revalidation triggers.
For engineering, it means keeping valid sibling work, current constraints and
ownership through interruptions. Skills, helpers and incident intake serve these
workflows rather than becoming the sole organizing concept.

Three knowledge failures remain explicit: lost continuity, missed applicability
before a decision, and late discoveries that require earlier decisions to be
reviewed. They interact with execution failures but are not interchangeable.

## Component contracts and precedence

| Contract | Owns | Consumes without redefining |
| --- | --- | --- |
| [Execution and recovery](execution-recovery-contract.md) | Work identity, attempts, admission, stop/effects, budget ledger, capability receipts, failure envelope and legal plan revisions | Exact knowledge/approval references; milestone evidence |
| [Knowledge and environment](knowledge-environment-contract.md) | Identity, typed references, observations, provenance, approvals, skills/helpers, compilation, freshness and derived indexes | Execution receipts; current authority and membership |
| [Context and decisions](context-decision-contract.md) | Applicability, decision dependencies, working sets, capacity allocation and request-bound delivery | Knowledge revisions, capability receipts and current work |
| [Coordination and improvement](coordination-improvement-contract.md) | Run sharing, delivery cursors, handoffs, progress observation, improvement proposals and evaluation | Executor ownership/budgets; knowledge evidence; context delivery |

Each field/transition has one owner; other contracts reference it instead of
defining a competing record. Existing persistence modules stay authoritative.
Cross-store references and approvals are defined in knowledge; the diagnostic
envelope, budget lineage and host capability descriptor are defined in execution.
An incompatible proposal is a design gap to resolve before implementation, not a
reason to select a convenient alternative at runtime.

The two adapter/feature specs are part of the same design set:

- [OpenCode V2 design](opencode-v2-design.md): host bindings, transcript conversion,
  packaging and version-specific probes. It implements the shared execution and
  context contracts on both hosts; it does not own another recovery policy.
- [Incident watcher design](incident-watcher-design.md): configured log intake,
  occurrence grouping and bounded work admission. It uses the existing incident
  model and executor; it does not own another DAG scheduler or failure taxonomy.

These reconciled drafts preserve Claude's 2026-10-13 research and source references.
Their version-specific host claims remain research snapshots until their probes
pass; editing this design does not certify a newer host or an installed deployment.

This linked seven-document set is the canonical proposal for this program. Earlier
copies of the V2 and watcher drafts are historical inputs, not competing contracts.
Keep their original research attribution; resolve future changes in this set.
Canonical design status does not mean released behavior or implementation approval.

## Shared operating loop

At an explicit task/plan boundary, resolve the current work and environment,
select approved applicable procedures, and assemble the complete required context.
Before covered dispatch, recheck authority, freshness, ownership, budget and any
unresolved effects. Commit observations and verification at their own durable
boundaries. Route meaningful changes to affected decisions and authorized workers.

Compaction restores this state; it does not manufacture it. The compiler may later
propose reusable lessons from eligible evidence, but no synthesis call belongs in
the per-request critical path. An observation can inform context without becoming
a trusted instruction, and an event can request reconciliation without authorizing
a replay.

## Reconciliation decisions

| Topic | Resolution across the design set |
| --- | --- |
| Missing host session | Unknown unless same-instance/epoch evidence and tested semantics prove no dispatch/admission; deletion is not proof nothing ran. |
| Stop or restart | Shared execution contract applies on V1 and V2. Termination and effect settlement are separate. |
| Successful siblings | Existing done outputs are already durable. Add dependency-checked selective continuation, not a second persistence system. |
| Step exhaustion | Use confirmed host evidence and bounded task sizing; do not classify every empty response as a step limit. |
| Approval | V1 application policy delegates exact-revision approval to the harness; separate approval from loading and human review. Bind policy, project, closure and scope; recheck revocation. |
| Recovery scope | Derive conflict and replay safety from enforced capabilities and resource effects, not an agent role, a stop request or `git status`. |
| Host identity | Record verified, unverified or unavailable epoch evidence. An ALG store ID is not proof of host database continuity. |
| Context allowance | Complete mandatory content precedes optional weights; an explicit hard ceiling bounds any increase above the normal target, and no byte floor exceeds safe request capacity. |
| Watcher fingerprint | Scoped occurrence grouping, distinct from failure code and root-cause identity. |
| Observer and breaker | Shared diagnostic envelope; advisory observation does not grant execution authority. |
| Capability table | One tested descriptor; V2 and watcher tables are views/requirements, not separate truths. |
| Historical evidence | Active context is not full history. Preserve coverage and as-of knowledge; no hindsight leakage. |
| Cost and evaluation | One cumulative ledger; report outcomes and errors by build, not lifetime failure counts interpreted as current causality. |

## Existing foundations and gaps

The implementation, rather than older planning documents, defines the baseline.

| Area | Existing behavior | Gap addressed here |
| --- | --- | --- |
| Skill identity and bodies | [SkillIndex](../src/session-memory/skill-index.ts) pins complete files, declared prerequisites, and hashes. `bind` creates session-owned skill nodes with empty `relations`. | Explicit logical identity, revision history, and relationships to resources and decisions. |
| Activation | [SessionMemoryRuntime.observe](../src/session-memory/runtime.ts) activates unambiguous exact-name mentions or successful skill loads. Similarity alone remains discovery. | Applicability from planned operations and resource identity, without requiring the user to know a skill name. |
| Legacy guidance | [SkillGuidance](../src/skill-catalog.ts) uses turn hints and retains skill references; its guidance is tied to skill-evolution enablement. | One selection policy and delivery owner, independent of skill learning. |
| Context assembly | [buildContext](../src/session-memory/context.ts) verifies and includes complete bound skills; mandatory overflow reports `needs_context`. | Separate durable relevance from the smaller set of instructions required for this phase. |
| Retrieval | [retrieve](../src/session-memory/retrieval.ts) follows outgoing edges from session pins within node, edge, and depth limits. | Indexed reverse lookup, typed cross-store references, and explicit decision impact traversal. |
| Environment graph | [Environment schemas](../src/environment-memory/schemas.ts) represent resources, topology, scoped relationships, provenance, and validity. | Links to procedural knowledge; no skill entity kind currently exists in that graph. |
| Action preflight | [executeWithMemory](../src/session-memory/attempts.ts) covers ALG run/resume under a specific active-procedure/environment contract. | Coverage-aware procedure requirements for individual instrumented operations. |
| Evidence and learning | Experience objects and historical skill audits retain bounded evidence and checkpoints; completed-invalid child calls have a distinct recovery contract. | Incremental cross-source assertions and dependency invalidation, without replacing historical auditing or weakening its coverage rules. |
| Knowledge inspection | Memory tools expose scoped objects and context diagnostics. | Rebuildable human-readable views and structured knowledge-health reports tied to committed revisions. |
| Worker lifecycle | Child cancellation requests a host abort with a bounded best-effort wait; run writes use fencing. | Durable distinction between requested cancellation, confirmed termination, and unknown termination; safe replacement across declared effect scopes. |
| Team coordination | The DAG and live views record child attempts and saved progress; memory delegates scoped context to children. | Authorized sibling knowledge delivery, verified handoffs, task ownership, and progress checks without a second executor. |

Related contracts remain authoritative for existing behavior:
[session memory](session-memory.md), [context budget](context-budget.md),
[environment memory](environment-memory-design.md), and
[session continuity](session-continuity.md). This draft does not rewrite their
historical implementation or validation claims.

## Design decisions

1. Preserve full skill instructions as source artifacts. Graph metadata helps
   discover and select instructions; summaries do not replace them.
2. Extend the existing session-memory records, experience adapters, and environment
   resolver. Do not add a third authoritative database, vector service, or MCP.
   Optional compilation uses bounded, explicitly enabled jobs, not an always-on
   model or an implicit background service.
3. Separate logical skill identity, immutable revision, task binding, and observed
   application. None is interchangeable with another.
4. Make retrieval explainable and deterministic before adding semantic ranking.
   Similarity can suggest relevance, but cannot establish a mandatory requirement.
5. Persist decisions and their dependencies when they change, not only at a
   compaction callback. A summary is never the sole recovery checkpoint.
6. Keep memory, instruction trust, evidence strength, and action authorization
   distinct. A graph path does not grant permission.
7. Build one host-independent core with thin OpenCode adapters. No model names,
   provider-specific heuristics, or model-dependent schema coercion belong here.
8. Separate immutable inputs, proposed assertions, published knowledge, verified
   resolutions, and reviewed skills. Publication means durable availability, not
   factual verification or authority to execute.
9. Make derived knowledge incrementally rebuildable. Record source revisions,
   derivation versions, dependency paths, and coverage; never treat a summary of
   another summary as independent corroboration.
10. Keep compilation out of the model-request and compaction critical paths.
    Those paths restore committed state and report gaps; they do not wait for
    fresh knowledge synthesis or spend additional model calls.
11. Sharing a finding changes its audience, not its evidence strength or action
    authority. Bind team access and delivery to the exact run and membership epoch.
12. A cancelled request, expired lease, or missing heartbeat does not establish
    that a worker or its external effects have stopped. Replacement requires a
    verified termination or isolation boundary and reconciled effects for the
    affected resources.

Non-goals for the first implementation are lossless transcript archival,
autonomous network/credential discovery, global cross-project knowledge sharing,
automatic skill promotion, arbitrary shell interception, autonomous web research,
and general causal inference. Existing environment replication does not automatically
replicate session-private skill bindings or decisions.

## Storage and architecture boundaries

Extend immutable session-memory objects for the new records; publish objects before
advancing owner/run/project heads under the existing locking and revision-CAS protocol.
Never advance a processed-event cursor after a failed write. Orphaned objects are
not committed knowledge until referenced by a committed head.

There is no distributed transaction across memory stores. An assertion pins the
referenced environment revision/digest and readers verify both ends. A context
receipt records the exact revision vector it read. If a required source changes
during preparation, retry within a bound or return a conflict. Never represent a
mixed, unresolved snapshot as a single coherent observation.

Forward/reverse indexes and RAM caches are derived. Key caches by source revisions,
policy version, caller scope and membership epoch, and task/environment identity;
expiry and current membership must still be
checked at read time. Detect stale indexes, rebuild from committed heads, and expose
incomplete discovery during rebuilding. Stable paginated queries bind their cursor
to a revision; changes require restart rather than silently skipping entries.

The proposed code boundaries are small additions around existing responsibilities:

| Boundary | Responsibility | Must not do |
| --- | --- | --- |
| Schemas and transitions | Typed identities, relation endpoint rules, eligibility and temporal transitions | Perform filesystem, network, or model calls |
| Registry and resolver | Verify exact artifacts and scoped cross-store references | Grant access or guess source identity |
| Selection policy | Match structured intent, expand prerequisites, explain selection | Mutate evidence or silently promote inferred policy |
| Decision impact queries | Bounded reverse traversal and review deduplication | Invalidate unrelated work or execute repairs |
| Context assembly | Budget complete instruction closures and emit receipts | Summarize away mandatory instructions |
| Host adapters | Correlate requests/children and enforce declared action boundaries | Duplicate domain rules for individual models |
| Compiler | Plan units, extract proposals, validate provenance, and publish scoped revisions | Promote skills, mutate source systems, or create a second DAG executor |
| Knowledge health | Validate committed references, freshness, lineage, and declared coverage | Treat semantic guesses as deterministic failures or permissions |
| Projection renderer | Export inspectable views from an exact visible revision set | Become authoritative or automatically ingest viewer edits |
| Run coordination | Scope membership, deliver bounded events, and project task ownership from run authority | Broadcast private context or independently schedule workers |
| Execution lifecycle | Record stop/reconciliation evidence and fence covered replacements | Infer termination from a timeout, lease expiry, or missing heartbeat |
| Progress and observer | Evaluate milestone evidence and propose bounded reviews/replans | Change success criteria, execute repairs, or create a second orchestrator |

Prefer explicit record types and pure functions over a generic graph framework or
a second executor. Keep `src/index.ts` as lifecycle wiring. Reuse canonical hashing,
bounded readers, mutexes, and budgets; avoid two implementations of skill matching
or scope checks. Reject unknown schema fields at trust boundaries and use typed,
sanitized errors. Public tool growth must be justified by a user operation, not
one new tool per record type.

### Implementation map

The following ownership is normative; filenames for new modules may be adjusted
without changing their responsibilities. Do not place all new behavior in runtime
or hook files.

| Existing or proposed module | Implementation responsibility |
| --- | --- |
| `src/session-memory/schemas.ts` and focused schema modules | Versioned skill, assertion, derivation, decision, job, receipt, and selector contracts; strict bounds and transitions. |
| `src/session-memory/store.ts` | Additive immutable variants and fenced knowledge/job heads using existing canonical serialization and path safeguards. |
| `src/session-memory/skill-index.ts` | Stable identity mapping, reviewed manifest validation, exact revisions, and prerequisite closure. |
| New `src/session-memory/knowledge-resolver.ts` | Typed cross-store reads, source spans, current/as-of semantics, and dependency-vector checks. |
| New `src/session-memory/skill-routing.ts` | Pure applicability selection and explanations over already scoped inputs. |
| New `src/session-memory/knowledge-compiler.ts` | Unit planning, bounded job transitions, deterministic extraction, validation, and publication. |
| Shared private-call support extracted from skill evolution where appropriate | Permission capability checks, model dispatch, accounting, terminal/rejection receipts, cancellation, and safe retry feedback; preserve legacy plan contracts. |
| New `src/session-memory/knowledge-impact.ts` and `knowledge-health.ts` | Derived reverse indexes, invalidation frontier, scoped decision review, and health findings. |
| New `src/session-memory/knowledge-export.ts` | Revision-bound Markdown rendering and manifest-last export. |
| New `src/session-memory/run-coordination.ts` | Run-scope memory resolution, recipient cursors, policy-bound publication, and delivery through existing context assembly. |
| `src/session-memory/skill-index.ts` and a focused helper-artifact module | Exact helper contracts and validation references; reuse existing artifact and dependency storage. |
| `src/sessions.ts`, `executor.ts`, run schemas/store, and a focused lifecycle module | Typed stop receipts, execution generations, safe replacement, membership/assignment authority, and plan revision validation. |
| Focused run-progress/observer logic and existing live views | Milestone verification, stall classification, safe findings, and read-only display; no new scheduler. |
| `src/session-memory/context.ts`, `runtime.ts`, and `attempts.ts` | Integrate selection, complete instruction delivery, decision capture, and covered preflight. |
| `src/session-memory/tools.ts` and existing memory CLI | Bounded read/status extensions and explicit compiler/lint/export operations. |
| `src/index.ts` and host adapters | Lifecycle event wiring and capability reporting only. |

Pure routing/validation code must not import host SDKs, model providers, or filesystem
implementations. Inject scoped resolver, clock, budget, and persistence interfaces
at boundaries. Keep adapters small; do not create a generic graph framework, a
second matching policy, or a new locking implementation. Avoid speculative parser
registries until a concrete source adapter needs them.

### Configuration and operator surface

Routing, compilation, run sharing, helper eligibility, observation, automatic
replanning, semantic lint, and action enforcement are independently controlled.
New assistance defaults off. Baseline safety remains enforced: no flag may turn an
unknown stop/effect outcome into confirmed termination or permission to replay.
Observation-only routing may record selection diagnostics but cannot change
bindings, prompts, or tool outcomes. Run sharing requires an explicit policy;
enabling observation does not enable automatic replanning or worker replacement.
Compilation may be enabled for deterministic sources without enabling model calls;
optional model extraction also requires the private-host capability and an approved
budget. Existing skill-learning enablement never implicitly enables compilation.

Proposed CLI operations are `compile preview/run/status/resume/cancel`, `knowledge
lint`, and `knowledge export` under the existing memory CLI. These are interface
requirements, not commands supported by today's build. Preview is read-only with
zero model calls; run/resume bind the approved plan digest. Status/read/search never
start compilation or fetch a remote source. Cancellation retains committed results
and receipts and does not declare an in-flight unknown child complete.

Extend `alg_context_status` with routing reasons, delivery state, active source
revisions, pending invalidation, compiler availability, job/coverage counts, and
adapter coverage. Existing run status also reports membership epoch, recipient
delivery lag, helper eligibility, verified milestones, stop/reconciliation state,
and observer coverage without claiming a stale snapshot is live liveness.
Extend existing memory search/read through explicit record-kind filters, stable
revision-bound cursors, and source-expansion handles. Each response
reports omissions and incomplete coverage within its visibility boundary. Keep
large bodies opt-in; no new MCP or proliferation of model-visible tools is required.

Compilation defaults to session-private assertions. An explicitly configured run
sharing policy may permit run-scoped compilation from sources whose complete needed
closure is already visible to the intended recipients. Session-private inputs need
a separate authorized run-publication step first; a compilation unit cannot widen
their visibility. Membership is necessary but not sufficient authorization.
Private-to-project publication still requires a later explicit review workflow over
the complete source/relationship closure. Filesystem permissions and operator
policy remain the review boundary; a model-supplied `approved: true` field is not
evidence of operator approval.

## Privacy and trust

Session decisions and applications remain private by default. Run sharing admits
only policy-eligible records to currently authorized roles, with separate checker
inputs. Project publication requires explicit review of the record and its
relationship closure; a shared skill must not expose private sessions or runs
through reverse edges, counts, or paths. Apply scope and membership checks before
ranking, traversing, or reporting omissions. Cross-project sharing is deferred.

Only configured trusted skill sources supply executable instructions. Graph
evidence, tool output, model-authored proposals, and semantic search results remain
untrusted data. Promotion into a reviewed skill or mandatory manifest rule uses a
separate explicit approval path. An application saying "worked" cannot promote
itself to verified evidence.

Store credential-provider references, never credentials or secret-bearing URLs.
Do not use raw commands, connection strings, or private tool output as routing keys.
Sanitization is defense in depth, not a guarantee that every secret can be detected.
Local hashes do not protect against an actor able to rewrite the stores coherently.

## Compatibility and migration

Introduce versioned record/manifest contracts with additive readers for existing
records. A new record format version is unrelated to the OpenCode host version.
Keep old immutable records byte-identical. Migration maps references explicitly and
records its source heads and output heads; it must not invent missing timestamps,
review approvals, or evidence relationships.

Do not silently begin new-format writes that make an existing deployment unable to
read its head. Stage migration into a separate versioned head, validate it, and
switch through an explicit operator step. Downgrade must either use a verified
compatible checkpoint or report incompatibility; never discard post-migration work
to make the older version appear current.

Legacy behavior remains available when routing is disabled. Once the new delivery
owner is active, suppress duplicate legacy skill injection through a single adapter
path. Existing environment replication remains unchanged and does not replicate
session/run-private state. Combined backups must include session/run knowledge
objects, artifacts and heads, referenced environment history, and the authoritative
run membership, delivery cursors, assignments, lifecycle and milestone receipts.
A missing store after restore is an explicit gap, not an empty successful graph.
Restored membership is historical evidence, not a fresh authorization: revalidate
current access, ownership and in-flight effects before delivery or dispatch.
Legacy runs without stop receipts remain unconfirmed; migration cannot reinterpret
`cancelled` or an expired lease as confirmed termination or safe replacement.

Set record, traversal, event, and artifact quotas before enabling automatic capture.
Quota exhaustion is visible and cannot silently evict active pins. Automatic garbage
collection and private-to-project publication are not part of the first slice;
archive/prune design must preserve historical references before it is introduced.

ZIP-based deployment must ship source, schema versions, and changed agent assets as
one identifiable package. Keep source identity, migration compatibility, and host
capability in diagnostics. Installation does not hot-reload an existing OpenCode
process: restart and verify the loaded identity before acceptance. Preserve explicit
scope/identity mappings when moving a checkout; do not infer cross-project identity
from equal filenames or hashes.

### Design integration and packaging

Before runtime implementation, integrate these documentation changes onto the
then-current main, including the shell-gate fixes already in the implementation
target. Preserve unrelated work and resolve contract conflicts explicitly; this
documentation update itself does not rebase, merge or change runtime code.

The proposed first V1 release includes the seven linked design documents as inert,
clearly marked draft documentation so the README links remain usable offline:
`skill-knowledge-graph-design.md`, the four `*-contract.md` files in the component
table, `opencode-v2-design.md`, and `incident-watcher-design.md`. Review these exact
paths in the release inventory; do not allowlist the entire docs directory or ship
unrelated working notes. Including the V2 design does not include V2 implementation.
Before packaging that release, update the exact support-path allowlist and verify
the local packed inventory and relative links. No release-script change is part
of this spec-only update.

## First V1 implementation phase

**V1 Phase 1 delivers approved procedure continuity, not the complete operational
model.** A user selects a trusted procedure once; subsequent requests, compactions
and a controller restart restore the exact applicable instructions without another
skill reminder. The existing run state supplies the objective and next action.
Source drift, missing instructions, uncertain delivery and capacity gaps stay
visible instead of being hidden by a summary.

This phase combines increment 0, the minimum identity work from 1, and continuity
increment 2 below. The increment numbers are contract work packages, not a demand
to complete all of 1 or recovery increment 0a before shipping Phase 1.

1. Pin the V1 build/configuration and record current context coverage. Keep routing,
   learning, compilation, sharing and watcher enablement independent.
2. Reuse exact existing skill revisions and prerequisite closures whose source
   trust and task scope can be validated under the deployment's operator policy.
   Persist only the minimal versioned binding and delivery records needed here;
   do not require broad environment import or a graph migration. A legacy pin is
   not new approval. Explicit configuration delegates application-level approval,
   without claiming protection against unrestricted same-user writes.
3. Restore the task-scoped working set before each covered model request through
   one V1 delivery owner. Persist bindings when they change, not just on compaction;
   missed compaction callbacks and process restart must not lose the binding.
4. Include complete instructions and prerequisites once, within the explicit
   ceiling and safe capacity estimate. Report `needs_context`, stale/revoked source
   or unknown coverage for the affected operation; do not silently clip or repin.
5. Expose the chosen revisions, reasons, omissions and delivery evidence through
   existing context status. Preserve current permissions and recovery behavior;
   this phase enables no new worker replacement or automatic continuation.

The first approval workflow is the knowledge contract's exact-revision policy and
`alg_skill` preview/approve/load tool, not a new UI or protected service. The
operator configures allowed rules once; the harness approves and loads within
them. Outside-policy revisions remain candidates. Legacy no-policy mode stays
unattested. This boundary changes no host permissions and does not enable V2.

The local Phase 1 gate uses a preapproved synthetic skill and prerequisite, twenty
forced compactions, a controller restart, a missed callback and a plain "continue"
request. It requires zero additional skill reminders, exact bytes, no duplicate
injection with learning disabled, honest request-bound delivery states, and visible
missing/revoked/changed-source and insufficient-capacity results. Include scoped
parent/child delivery, interrupted binding writes, default and explicitly raised
caps, and disabled-feature compatibility. Synthetic delivery is not evidence of
installed-host confirmation: any such claim requires the pinned V1 hook check.
Run checks locally; no GitHub runners or implicit paid-model calls.

The next V1 phase adds explainable deterministic routing over approved rules and
declared resources. Unapproved/inferred matches remain recommendations. Recovery
hardening can proceed separately and must pass its own gates before replacement,
autonomous continuation or scheduled watcher admission. Compilation, broader
environment acquisition, run sharing, observers, embeddings and all V2 work are
outside Phase 1; their contracts remain part of the umbrella roadmap.

## Delivery increments

### Phase 1 implementation handoff

The first release is a vertical V1 continuity slice across the existing stores and
hooks, not four parallel subsystem rewrites. Use the following scope when assigning
implementation work; the broader contracts remain the destination architecture.

| Contract | Required in Phase 1 | Deferred from Phase 1 |
| --- | --- | --- |
| Execution and recovery | Read existing work identity and state; preserve current replay and permission boundaries | New continuation, replacement, effect reconciliation and task decomposition |
| Knowledge and environment | Exact skill/prerequisite revisions, scoped durable bindings, validated existing trust and drift/revocation checks | General environment import, new graph infrastructure, compilation and promotion |
| Context and decisions | One V1 delivery owner, complete restoration, final byte accounting, request-scoped receipts and visible gaps | Proactive applicability routing, broad decision-impact traversal and new action enforcement |
| Coordination and improvement | Preserve existing parent/child isolation and expose continuity diagnostics | New sharing, observers, watcher admission and automatic replanning |

Implement in dependency order: validate binding/trust inputs; persist bindings at
change boundaries; assemble complete bounded packs; publish through the V1 hook;
record the actual delivery outcome; then exercise restart and fault fixtures.
Keep host-hook wiring thin and the selection/accounting logic independently testable.
Do not introduce a generic graph framework or host-port rewrite merely to prepare
for V2. A minimal shared interface is justified only by a current V1 caller.

The acceptance report must map every Phase 1 requirement to a local test or an
explicit remaining gap. Record the source build, enabled configuration, host or
synthetic adapter identity, trust-policy boundary, delivery evidence level and
storage limits. Include sustained repeated-hook cost and quota exhaustion; a
twenty-compaction pass alone does not establish multi-day operating reliability.
Never silently evict active bindings or report an uncertain write as delivered.

Complete the slice only after its required fixtures pass and unresolved trust,
capacity or delivery gaps are either fixed or explicitly excluded from the
declared supported scope. Synthetic tests establish harness behavior, not actual
model adherence. Package and link checks stay local, including the ZIP deployment
path; no GitHub runner, paid-model run or installed-host probe is implicit.

Phase 1 completion does not authorize the next increment. V2 remains design-only,
including its runtime probes, dependencies, packaging changes and migrations.

Historical mixed-version failure data informs fixtures, not a current causal
ranking. Start with a pinned-build baseline that separates extraction, schema,
gate-authoring, quality rejection, confirmed step exhaustion and unknown outcomes.
Measure stranded usable work and repeated diagnostics as well as terminal failure.

Prioritize frequent current failures and high-impact safety prerequisites together.
Basic visibility/context work can proceed beside recovery hardening; it need not
wait for a compiler, watcher, V2 port or a full knowledge graph.

| Increment | Deliverable and owner | Local completion gate |
| --- | --- | --- |
| 0 Baseline and visibility | Shared loaded-build diagnostics, context omissions, typed failure categories, completed-work and effective step-budget reports | Reproduce representative current failures; distinguish unknown attribution; preserve original evidence |
| 0a Recovery and task sizing | Execution contract: host binding, safe stop/effects, selective continuation, budget lineage and plan-size/checkpoint contracts | Keep valid siblings; block uncertain replay; decompose incomplete work without weakening criteria or resetting cost |
| 1 Identity and bootstrap | Knowledge contract: minimal validated bindings for Phase 1; broader approvals, scoped imports and skill/environment identity in subsequent slices | Exact source resolution and minimal record migration first; new approval/import workflows require their own tested boundary, without blocking reuse of existing valid approvals |
| 2 Continuity and capacity | Context contract: durable working set, complete restoration, mandatory precedence, stable packs and delivery receipts | Twenty compactions plus restart, no reminder needed, no clipped instructions or over-capacity floor |
| 3 Proactive routing | Context contract: portable manifests, bounded path/tool/failure predicates, exact resource routing and explanations | Correct unnamed-skill selection; inferred signals stay advisory; missing approval/resources are explicit |
| 3a Coordination | Coordination contract: run scope, handoffs, delivery cursors and tested helper reuse | No private leakage; corrections survive restart; handoffs cannot bypass 0a |
| 4 Incremental compilation | Knowledge contract: explicit bounded jobs, source-backed proposals, per-unit publication and recovery | Invalid terminal output is retryable within policy; unknown calls remain distinct; independent units survive |
| 5 Invalidation and progress | Knowledge/context/coordination contracts: dependency updates, decision review and evidence-based milestone/stall signals | Only affected work is reconsidered; unchanged failures do not loop; original budgets and criteria hold |
| 6 Covered enforcement | Execution/context contracts: explicit policy and installed-host boundary conformance | Missing instructions/authority/freshness or unresolved conflicting effects block covered dispatch; uncovered actions stay visible |
| 7 Inspection and observation | Knowledge/coordination contracts: deterministic health, readonly observer, optional semantic proposals and Markdown views | Seeded defects found with scope; no observation grants authority; views rebuild deterministically |
| 8 Integrated endurance | Shared local fault and soak profiles | Report actual duration/workload, restarts, memory/storage, unresolved outcomes and total cost |

Increment 0a owns its run-record migration and may proceed in parallel with 1-3.
The relevant schema/migration subset of 1 precedes any new memory-format writes;
the whole import/approval subsystem is not a prerequisite for Phase 1. Compiler 4
is not a dependency of continuity 2 or initial routing 3. Automatic replacement/replanning and scheduled
watcher admission require the relevant 0a safety boundary; a read-only context
release does not wait for V2. Host-native improvements are adapter work, not changes
to model-agnostic core policy; only V1 adapter work is in the current delivery scope.

Ship each independently useful increment with its own enabled-feature acceptance
report. The complete program scenario is an integration gate, not a demand to build
all increments before improving skill continuity. Keep optional features off until
their local gates and any required host probes pass.

## End-to-end program scenario

Investigate a synthetic discrepancy between a dashboard and an API-backed dataset.

1. Resolve declared repository, API, dataset and principal identities and approved
   grain/timezone/read-only procedures without naming a skill in the request.
2. Use two bounded read-only workers. Publish a verified pagination finding and
   exact tested helper only to authorized recipients; keep checker inputs separate.
3. Commit valid sibling outputs. Interrupt the other worker after a simulated
   external operation; distinguish the worker's stop from its unknown effect.
4. Compact and restart, restore the same work and required instructions, and
   reconcile before selectively continuing. Do not rerun valid independent work.
5. Change an API schema or dataset version. Retain historical truth, invalidate
   present use only where dependent, and replan within the original authority.
6. Verify the corrected result against exact data/evidence. Record unresolved
   uncertainty and cost, then explicitly compile an eligible candidate lesson.
   Sharing or compilation never promotes that lesson into an approved procedure.

The [coordination contract](coordination-improvement-contract.md#end-to-end-acceptance-scenario)
retains the full fault matrix, paired ablations and one-hour/optional 24-hour
profiles. Add sanitized local missed-skill cases when available, with versioned
inputs and held-out cases. No air-gapped data export is required.

## Implementation decisions and open deployment choices

The architectural defaults are settled here: one executor, existing stores, four
component contracts, immutable provenance, model-agnostic policy and no automatic
remediation. Before implementation of each affected increment, settle:

| Choice | Proposed default | Required evidence or owner input |
| --- | --- | --- |
| Initial source inventory | Explicit trusted roots and selected repository/config imports | Actual skill/resource inventory on each machine; do not extrapolate from this workstation |
| Applicability packaging | Namespaced skill frontmatter compiled to one manifest; sidecar if V1 rejects it | Supported V1 parser check and conflict fixture; a V2 check belongs to the deferred V2 work |
| Approval boundary | Application-level exact-revision policy; harness approval and separate loading | Check project, source closure, scope, policy revision and revocation; unrestricted same-user writes are not isolated |
| Runtime coverage | Enable only verified capabilities required by that feature | Exact adapter/host/source conformance receipt |
| Recovery evidence | Enforced resource/effect scope; explicit unavailable epoch evidence | No role-only replay permission, no fabricated host epoch; allow demonstrably non-conflicting work within budget |
| Budget and workload ceilings | Normal context target plus an explicit hard ceiling; one cumulative spend lineage | Existing configurable caps suffice for Phase 1; no automatic ceiling increase or inference of spend authority from a spec |
| Watcher inputs and deployment | Diagnose-only, local files/manual intake, off by default | Declared paths, host, quotas and separate schedule/install approval |
| V2 rollout | Deferred design work; no V2 implementation or runtime probe now | Finalize its design and obtain explicit authorization to begin; never a V1 delivery gate |

Final wire schemas and migration manifests are implementation-review gates; the
component examples define semantics, not currently accepted configuration fields.
No version floor, live probe, service installation or paid-model evaluation is
approved by this documentation update.

## Completion and deferred work

Before an increment is called complete, its documented scenarios, privacy,
migration and accounting checks must pass locally against a pinned build. Installed
host behavior requires adapter evidence; synthetic responses establish core logic,
not live-model competence. Release claims name exactly which features and hosts
were tested. No tests run on GitHub runners.

Roll out Phase 1 continuity and visibility first, then approved routing. Gate
bounded continuation separately on recovery evidence; add coordination, compilation
and inspection as their own acceptance evidence justifies them.
Rollback preserves new records and failures; incompatible old readers must refuse
new-format writes rather than erase state. ZIP deployment binds code, schemas and
agent assets, followed by restart and loaded-source verification.

Embeddings may later improve candidate discovery, never mandatory policy or access.
A new graph database needs measured query/indexing justification. S3/drive
replication of private session/run knowledge needs its own scope/recovery review;
existing environment replication does not silently acquire that responsibility.

## Design references

- [A team of Gemini 4 Argon agents beats Minecraft](https://arxiv.org/html/2610.22319v1),
  especially sections 2-4 and 8, motivates shared lessons, reusable helper programs,
  cancellation generations, independently checked progress and long-horizon
  evaluation. ALG adapts these as model-agnostic, scoped, evidence-backed contracts;
  it does not adopt a model-specific orchestration recipe. The paper describes one
  Easy-difficulty run with privileged state observations and prior task knowledge,
  not a comparative reliability study. Its outcome does not establish a causal
  benefit, production safety, or expected success rate for ALG.
- Karpathy's [knowledge-base workflow](https://x.com/karpathy/status/2039805659525644595),
  [idea-file follow-up](https://x.com/karpathy/status/2040470801506541998), and
  [LLM Wiki design](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  motivate persistent synthesis over preserved sources, linked knowledge, and linting.
- Rvania's [compiler essay](https://x.com/rvaniaaaa/status/2090512486738845784) and
  [repository roundup](https://x.com/rvaniaaaa/status/2111085365171790269) motivate
  incremental maintenance; their popularity and scale claims are not acceptance evidence.
- Hasan's [LLM Wiki post](https://x.com/hasantoxr/status/2098766600828854358) points to
  [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki), which documents staged ingest,
  source traceability, a persistent queue, and an optional external query surface.
- Data Science Dojo's [workflow illustration](https://x.com/datasciencedojo/status/2073127309926928461)
  highlights navigation through linked concepts rather than isolated fragments.
- [Graphify](https://github.com/Graphify-Labs/graphify) and
  [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) provide
  examples of separating extracted structure from inferred interpretation and of
  incremental graph updates. They are references, not required dependencies.

ALG's adaptation keeps typed authority, exact procedures, scope, current permission
checks, and durable failure accounting. Neither a link graph nor a compiled summary
proves a fact or grants access. Embeddings can improve optional discovery later;
the first implementation uses exact relationships and existing lexical lookup.
