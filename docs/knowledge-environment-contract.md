# Knowledge and environment contract

Status: Draft component contract, 2026-10-17. Part of
[durable operational context and execution](skill-knowledge-graph-design.md).
These are implementation requirements, not currently supported configuration.

This contract owns source identity, provenance, environment observations, procedural
artifacts, approval evidence, compilation and dependency invalidation. It describes
what ALG can justify about its environment, not a complete or automatically trusted
world model. The graph links existing authorities; it does not replace them.

Delivery targets V1. Shared record/interface design may support a later V2 adapter;
no V2 runtime, dependency or probe is required for this contract's V1 acceptance.

## Bootstrap and ongoing observation

Begin with the sources already available on a particular installation, without
assuming the workstation's inventory represents an air-gapped deployment:

1. An explicit inventory preview lists configured trusted skill roots, selected
   repository metadata, declared connectors and existing environment facts. Read
   only paths/sources already authorized; do not inspect credential values.
2. The operator chooses source roots and import policy, reviews aliases and scope,
   and approves the exact import manifest. Stable identities survive relocation
   only through an explicit mapping.
3. An authorized intake policy may capture bounded observations from tool calls
   that already occurred: repository revision, dataset schema, service/API version,
   observed route failure, or test result. This adds no discovery probe or access.
4. Resolve resource aliases and conflicts before using them as exact requirements.
   Model-inferred relationships remain proposals. Missing knowledge is a coverage
   gap, not evidence that a resource, dependency or restriction does not exist.
5. Revalidate on relevant drift, expiry, changed principal or changed environment.
   A successful connection yesterday does not prove current access.

Initial sources are operator manifests, repository-local declarations, exact skill
artifacts, approved connector metadata, and captured results under an intake policy.
Automated network/port scanning, secret enumeration and cross-project crawling
remain outside this slice. Read-only discovery still requires explicit scope.

Represent a route as conditional on source host/pod, destination, protocol,
principal, environment and observation time. Hardware, repository deployments,
API schemas and data snapshots have distinct identities and lifetimes. Credential
records contain provider references and allowed use, never secret material.
Network reachability, successful authentication and authorization are separate facts.

Illustrative observation, not an installable payload:

```json
{
  "id": "obs-api-pagination-17",
  "subject": "resource:orders-api",
  "predicate": "pagination_limit",
  "value": 500,
  "conditions": {"environment": "staging", "principal": "reader"},
  "origin": "observed",
  "evidence": "supported",
  "freshness": "current",
  "sourceRef": "artifact:response-fixture-17@digest",
  "verificationRef": "verification:pagination-check-17@digest",
  "observed_at": "2026-10-17T05:00:00Z",
  "expires_at": "2026-10-18T05:00:00Z",
  "scopeRef": "scope:run-demo@revision"
}
```

This record supports the tested pagination behavior only; it grants neither API
access nor permission to export data. Its expiry is an example, not a universal TTL.

## Review and approval records

V1 uses an **application-level delegated policy boundary**. The operator configures
the exact revisions and scopes the harness may approve. The harness can issue a
`policy-approved` receipt and separately load that revision without asking the
operator on every use. It cannot use this tool to expand policy or claim human
review. This replaces the earlier Phase 1 requirement for an independently
protected operator service or authenticated confirmation UI.

`sessionMemory.approvalPolicy` contains schema version 1, an explicit revision,
the canonical project identity, and at most 256 exact rules. Each rule binds a
source-specific skill key, the hash of its complete ordered file closure, and
exact environment and operation lists. The closure includes `SKILL.md`, `ALG.json`
when present, and every declared prerequisite. Empty scope lists retain the skill
manifest's unrestricted applicability; they are not a restricted-scope wildcard.
There is no model-specific behavior or semantic trust classifier.

`alg_skill preview` returns a candidate rule without changing bindings or approval.
The operator authorizes that rule in configuration and restarts the plugin.
`alg_skill approve` evaluates current bytes against policy and stores an immutable
skill node containing the receipt, without activating it. `alg_skill load` takes
that node ID, rechecks policy, revocation, scope and bytes, then binds it to the
session. Existing explicit-name/observed-load activation uses the same policy
check when policy is enabled. Discovery by similarity never activates a skill.

Receipts bind the complete policy hash, policy revision, project and exact rule.
They have no expiry in this first slice; remove the rule/change policy revision and
restart to withdraw policy, or revoke the stored node immediately. Repeated approval
of unchanged inputs is idempotent, not a new confirmation. A revoked node stays
revoked. Changing files or policy requires fresh approval and an explicit repin
when replacing an active revision. Restoration cannot upgrade a legacy pin into
an approval. Removing policy cannot downgrade an approved binding to legacy trust.

Configuration is a startup snapshot, not a hot-reloaded control plane. Policy
administration remains an operator responsibility; no ALG tool writes policy.
Same-user unrestricted shell or filesystem access can alter config, plugin code
or receipts. Hashes and local checks detect accidental drift, not coherent hostile
rewrites by that actor. Status therefore reports `APPLICATION_POLICY`, never OS
isolation, authenticated human confirmation or universal prompt enforcement.
Deployments needing adversarial isolation require a separately protected boundary.

Without policy, existing memory behavior remains available and explicitly
`NOT_ATTESTED`; the new approve/load tool cannot call that state approved. Skill
approval grants no shell, network, credential, sharing, promotion or remediation
permission. Host permissions continue to govern actions. Git commits, model
reviews and successful skill loads are evidence, not authority to expand policy.
Mandatory routing rules and broad knowledge import remain later V1 work.

## Record contracts

### Skill records

| Record | Required meaning and fields |
| --- | --- |
| Skill identity | Stable `skill_id`, source namespace, display name, and explicit source locator. Identity survives a reviewed revision; a renamed/moved source requires an explicit mapping. |
| Skill revision | Content-addressed revision of complete `SKILL.md`, declared prerequisite files, manifest, and schema version. Includes applicability and source provenance. |
| Helper artifact | Exact code/dependency digest, entry point, typed input/output contract, permitted effects, compatibility constraints, and scoped validation receipts; optionally referenced by a skill revision. |
| Task binding | Skill identity/revision, task epoch, phase or operation scope, environment reference, activation reason, and eligibility state. |
| Skill application | Session/child/run/attempt references, operation and resource identity, exact revision, context receipt, timestamps, and observed outcome/evidence references. |
| Decision revision | Explicit choice, concise stated rationale, assumptions, resource/environment references, dependencies, status, and supporting/refuting evidence. |
| Relationship assertion | Typed source/target references, scope, provenance, validity, authority classification, and supersession/revocation references. |

Store decision summaries and stated rationale, not hidden model reasoning. A
recorded decision is a workflow choice, not permission to execute it. A successful
attempt is an observed outcome under particular conditions, not proof that a skill
caused success or will work in another environment.

New logical IDs should be explicitly assigned in a reviewed source manifest.
Existing path-derived keys remain local legacy identities until explicitly mapped;
do not merge same-name skills or infer portable identity from a workstation path.
Maintain source aliases as reviewed records rather than silently rewriting history.

Canonical revision serialization must be versioned. Include instruction bytes,
dependency identities, and manifest policy in the revision hash. Reordering
metadata must have a specified canonical treatment; instruction bytes must not be
silently normalized. A hash proves local content consistency, not publisher trust.

### Knowledge and compilation records

Add these versioned record variants to session memory. Existing evidence, run,
skill, and environment objects remain in their owning stores; new records reference
them instead of duplicating their mutable state.

| Record | Required meaning and fields |
| --- | --- |
| Source snapshot | Stable source ID, exact revision/digest, allowed source kind, owning store/scope, artifact reference, source event address, capture policy version, timestamps, and coverage manifest. |
| Knowledge assertion | Stable logical ID and immutable revision; kind `observation`, `hypothesis`, `explanation`, or `lesson`; subject/resource references; bounded claim text or typed value; source spans; derivation reference; validity and evidence status. |
| Derivation | Ordered input revisions and fragment references, compiler/schema/prompt/parser versions, model configuration identity when used, child attempt references, output IDs, and declared coverage. |
| Compilation unit | Exact source/dependency manifest, recipe and scope digest, idempotency key, durable state, attempt receipts, hard budgets, publication receipt, and named coverage gaps. |
| Knowledge head | Revision-CAS pointer to a committed set of assertions, dependency manifests, conflict records, and publication receipts for one publication scope. |
| Invalidation event | Changed source/record revision, reason, affected dependency generation, and progress through a resumable impact traversal. |
| Health finding | Fixed issue code, severity, scoped affected references, evidence, scan revision vector, coverage, and resolution reference. |
| Projection manifest | Exact source heads, renderer version, caller/export scope, rendered file hashes, generation time, and omission counts. |

Source addresses for sessions must identify project, session, message/part or
run/node/attempt, and the immutable fragment digest where available. A source span
uses an artifact digest plus UTF-8 offset/length or a typed structured selector;
readers validate bounds and resolve it against that artifact. A display path or a
line number alone is not a durable citation. Redacted derivatives have their own
identity and mapping; citations must not point to offsets in different bytes.

Each assertion keeps three independent classifications:

- Origin: declared, observed, inferred, or unknown, with provenance.
- Evidence: proposed, supported, disputed, or refuted. `supported` requires a
  typed verification receipt or explicit review with a stated scope; a valid JSON
  shape or an LLM's assertion of confidence is insufficient.
- Freshness: current, stale, withdrawn, or unresolved. Publication does not imply
  freshness, and fresh hypotheses remain hypotheses.

Verified resolutions retain the existing evidence-linked resolution contract.
Reviewed skills retain complete instruction artifacts and their separate promotion
path. When skill evolution is separately enabled, compilation may submit a proposed
candidate through that review path; it cannot
write `SKILL.md`, `AGENTS.md`, host policy, credentials, or applicability rules.

New relationship types are `derived-from` (assertion to exact input revision),
`cites` (assertion to a validated source span), and `conflicts-with` (one assertion
to another). Keep `supports` and `refutes` for evidence rather than treating every
citation as support. Register allowed endpoint kinds and traversal semantics for
each relationship. A displayed symmetric conflict is one assertion, not two
independent witnesses.

Derivation references form an acyclic dependency graph even though the navigational
knowledge graph can contain cycles. Resolve shared ancestry before counting
corroboration: two summaries citing the same incident provide one source lineage.
Record unknown lineage as unknown; do not invent independent support. A model may
offer a new interpretation, but cannot upgrade the evidence status of its inputs.
Bound derivation depth to eight; over-depth or unresolved lineage cannot claim
complete provenance. Preserve original source handles so a later explicit job can
return to evidence rather than repeatedly summarize derived prose.

### Cross-store references

Use a strict address carrying `store`, `namespace`, `project`, `kind`, and `id`,
plus an exact revision/content digest where applicable. References are typed data,
not arbitrary paths or URLs to fetch. Readers resolve them through an allowlisted
adapter and the caller's independently validated scope.

Session memory remains authoritative for bindings, decisions, applications, and
procedural relationship assertions. Environment memory remains authoritative for
resource/topology facts. Existing run and experience stores retain their own
authority. Do not copy a mutable environment record into a second authority.

Application and decision records pin the environment revision they used. A
current-action query also checks current revocation and freshness; a historical
view cannot be reused as present authorization. If an exact historical revision
is no longer resolvable, report that gap rather than substitute the latest state.

### Relationships and direction

| Source | Relationship | Target | Interpretation |
| --- | --- | --- | --- |
| Skill revision | `applies-to` | Resource, resource class, or operation descriptor | Procedure is relevant under declared conditions. |
| Skill revision | `requires` | Skill revision or explicit prerequisite | Required complete instruction closure. |
| Decision or application | `used-skill` | Skill revision | Exact procedure associated with the decision or attempt. |
| Decision | `depends-on` | Decision or environmental assertion | A premise whose change can require review. |
| Evidence | `supports` or `refutes` | Decision or applicability assertion | Scoped evidence, not automatic truth or authority. |
| Application | `attempted-in` | Session/run/attempt reference | Durable address of the execution and its outcome. |
| New revision | `supersedes` | Prior revision of the same logical record | Forward change without erasing the old record. |

These are proposed typed relations, not current schema additions. Enforce an
endpoint-kind matrix; an arbitrary edge label must not create executable policy.
Provide forward and reverse indexes over the same assertions. Reverse indexes are
derived and rebuildable, never independently authoritative edges.

Reject cycles in required-procedure and supersession chains. Other graph cycles
may be meaningful; traversal must track visited identities and remain bounded.


## Provenance and timelines

Each assertion records source identity, source event/receipt, origin classification
(`declared`, `observed`, `inferred`, or `unknown`), review authority where relevant,
and temporal fields with different meanings:

- `recorded_at` and a monotonic store revision: when ALG learned the assertion.
- `valid_from` / `valid_until`: when it applies to the environment, if known.
- `observed_at` / `verified_at`: observation and verification instants, if known.
- `supersedes` / revocation event: how its interpretation changed.

Support both "what did this session know then?" and "what do we now believe was
true then?" using recorded revision and validity filters. Do not backdate knowledge
when importing an old incident. Wall-clock timestamps do not establish ordering
across independent writers; use per-store revisions and explicit causal references.
Unknown time remains unknown. Legacy skill nodes use a fixed creation timestamp
for identity stability; migration must not interpret that as a real application date.

Contradictory assertions remain inspectable. A newer or more frequently retrieved
claim does not automatically win. Conflicting required instructions produce a
visible conflict requiring resolution, not an arbitrary ranking tie-break.

## Tested helper artifacts

A skill may reference reusable code in addition to instructions. Each helper record
pins code bytes, entry point, dependency/lockfile digests, runtime/API constraints,
input/output schemas, permitted effects, and fixture identities. A validation
receipt binds that exact artifact to its test inputs, assertions, environment,
outcomes, and verifier version. Passing examples establish only the tested scope.

New helpers begin as candidates. Validate them on short local synthetic tasks in
an explicitly permitted sandbox before marking the artifact eligible for reuse.
Promotion into a reviewed skill is a separate approval path. No background package
installation, network access, arbitrary command construction, or production test
is implied by finding a helper in the graph.

At reuse, verify the artifact and dependency hashes, compatible runtime/environment,
current revocation, input contract, and validity of its validation receipt. Invoke
only through a covered adapter using normal host permissions. A tested helper is
not permission to execute it. If any required check is unavailable, return a typed
gap rather than regenerate an unverified substitute and silently run it.

Instructions still load completely. Helper code and full fixture logs stay outside
context unless needed; include the exact artifact handle, contract, and relevant
validation summary. Register helper revisions in the existing dependency graph so
an API change or revoked artifact identifies affected applications and decisions.
Examples include pagination, timezone conversion, and dataset-grain validation.

## Incremental compilation

### Intake and job boundaries

V1 supports explicit, scoped intake from completed ALG attempts and incidents,
existing immutable experience records, completed assistant answers stored as
unverified claims, reviewed local documents, and exact skill revisions. A bounded
fragment is eligible only when its manifest states which source material it covers.
An unfinished session is not implicitly a complete transcript. A completed answer
is not implicitly a verified outcome.

Optional automatic intake may enqueue references at durable completion boundaries
under an operator-selected policy. It must not enable paid model calls or execute
compilation in a message, compaction, or system-prompt hook. The first compiler
release runs jobs explicitly through a local CLI or an approved host operation. No daemon,
scheduled task, network crawler, or new tool permission is installed implicitly.
Exclude compiler/lint child sessions, exported views, and compiler-generated change
logs from automatic intake. Record origin lineage so writing a derived artifact
cannot trigger an infinite capture/compile cycle. Recompiling generated knowledge
requires an explicit plan and preserves its original ancestry.

Reject secret-bearing content before new persistence or hashing under the existing
memory rules. If intake fails, preserve already-eligible source records in their
original store and report the gap; do not copy unsafe raw transcripts as a fallback.
Untrusted source text is data, never instructions selecting tools or destinations.

A job preview freezes source revisions, scope, recipe, exact unit manifest, and
hard cost limits. The approved plan digest binds those fields. If required source
bytes cannot be pinned, report `source_unavailable` rather than fetching arbitrary
paths, following external URLs, or silently substituting the current source.
Preview computes and returns this manifest without writes. Run revalidates its
digest and source revisions, then persists the plan and eligible input artifacts
before dispatch. Changed or missing input requires a new preview; confirmation of
an earlier digest cannot authorize a different source snapshot.

Group work by a complete source or a declared self-contained fragment set, not by
an arbitrary character cut. Record excluded fragments. Assertions about absence,
exhaustiveness, or an entire repository require corresponding complete coverage;
one successfully processed fragment cannot establish them.

### Extraction and validation

Use deterministic extraction for structured facts already represented in schemas,
such as dataset IDs, recorded test outcomes, declared API versions, and run states.
Optional local parser adapters may later contribute code structure. Do not spend
model calls rediscovering fields the host already knows.

Use a model for bounded semantic proposals: explanations, candidate lessons,
possible connections, and suspected contradictions. The child sees only the scoped
immutable inputs required for its unit and returns a strict proposal envelope.
Persist concise conclusions and evidence references, not hidden reasoning.

Validate in this order before publication:

1. Response bounds, parser result, and the versioned strict schema.
2. Ownership/scope, endpoint kinds, source digest and span existence.
3. Complete declared dependency closure and provenance consistency.
4. Evidence-status rules, ancestry cycles, and conflict/coverage declarations.
5. Current source revisions, revocation, expected head, and remaining budgets.

Deterministic validity establishes structure and provenance, not the truth of a
semantic interpretation. A schema-valid model claim may be published as proposed
data but never as an automatically verified fact. Semantic review, when requested,
is a separately budgeted operation with a durable outcome.

Compiler children must use the existing private, tool-restricted model-call
boundary. If the host cannot enforce its required restriction, report
`unsupported_host` and keep deterministic intake and routing available. Never
fall back to an unrestricted worker or launch a nested ALG run. Reuse shared
model-agnostic parsing and sanitized retry feedback.
Diagnostics use fixed error codes and schema-owned paths, never untrusted key names
or source/response values echoed into retry instructions or persisted errors.

### Publication and crash recovery

Each unit follows `queued -> extracting -> validating -> publishing -> committed`.
Alternative durable states are `retryable`, `quarantined`, `blocked_unknown`, and
`cancelled`. A terminal failure records a typed reason and missing coverage.
`committed` means published knowledge, not verified knowledge.

Reserve attempt budget durably before child dispatch. Bind the attempt to its
source manifest and child session. A known terminal invalid response gets an
immutable rejection receipt before a bounded retry; it does not advance knowledge
coverage. Transport ambiguity, interrupted dispatch, and missing terminal evidence
remain unknown rather than being relabeled as parse failures.

Reconcile an unknown attempt only from authoritative host terminal evidence.
Without it, keep the unit `blocked_unknown` for explicit review and allow independent
units to continue. Known rejections that exhaust their budget become `quarantined`,
not unknown. No automatic replay of unknown calls or budget refund is permitted. A separately
approved replacement can supersede the unresolved unit without erasing its receipt
or pretending its cost is known. This extends the distinction in
[historical audit recovery](historical-audit-recovery.md), not its legacy plan format.
Replacement attempts within a job consume its remaining hard budgets and inherit
its deadline. A separately approved new job must retain links to unresolved prior
attempts and their cost uncertainty; it is not an automatic retry-budget reset.

Write validated immutable output objects first. Then advance one knowledge head
with a fenced compare-and-swap containing the unit's publication receipt, assertion
references, and exact input revision vector. Objects without a committed head are
not searchable published knowledge. If a crash occurs after the head swap but before
queue acknowledgement, resume recognizes the publication by its idempotency key
and acknowledges it without another model call or publication.

Never hold a filesystem lease across a model call. Reacquire the write fence and
revalidate inputs before publication. A CAS conflict retries publication within a
bound; it does not rerun successful extraction. Changed inputs require a new unit
identity and review of the old output, not publication against new premises.

One unit cannot atomically publish into multiple stores or visibility scopes.
Cross-store inputs are pinned references; explicit publication into another scope
is a separate reviewed operation. Derived indexes rebuild from committed heads.

Active jobs report queued/running state and their durable resume point. Terminal
dispositions distinguish `complete`, `partial`, `blocked`, and `cancelled`, with
committed, unresolved, excluded, and failed unit counts. Previously committed
independent units remain available. A partial job must never authorize a global
conclusion requiring its missing units. Historical skill-audit full-coverage and
promotion rules remain unchanged; this is not permission to skip their chunks.

Maintain separate intake and coverage cursors. Intake may acknowledge an event
only after its unit or rejection is durably recorded. Coverage advances only for
committed eligible units and retains holes explicitly; a rejection is not a review.

### Incremental work and budgets

The unit key includes publication scope, ordered source/dependency revisions,
canonicalization version, extraction recipe, relevant policy versions, and model
configuration identity when used. Never include credential values. Duplicate events
reuse the same committed result. A prompt/compiler/policy change creates a new
recipe identity; it must not silently reinterpret historical receipts.

Before recomputing, compare exact dependencies. Recompile only changed units and
their affected dependents. Rebuilding search or Markdown views does not require
re-extraction. Model-generated results are not guaranteed byte-identical across
runs; deterministic identity prevents duplicate commitment, not model variance.

Proposed initial safety limits, settled in umbrella increment 1 schema tests:

| Limit | Initial default |
| --- | --- |
| Concurrent compiler children | 1 |
| Units in one explicit job | 16 |
| Model calls per unit, including retries | 2 |
| Model calls and cumulative request bytes per job | 32 calls and 1 MiB |
| Child input and output | 16 KiB source payload; 32 KiB response; total prompt also charged |
| Assertions and relationship references per unit | 16 assertions, 32 references per assertion |
| Child timeout and job deadline | 120 seconds per call, 30 minutes absolute job deadline |

Apply the smallest relevant existing host, context, record, and budget bound.
Reserve reply space using the shared context planner; a source payload limit does
not guarantee a full prompt fits. Retry, resume, cancellation, and restart never
renew the original budget or deadline. Exhaustion yields partial/blocked status,
not a new job with reset counters. Changes to limits require an explicit new plan.
Expose charged calls, known usage, unknown usage, bytes, latency, queue age, and
remaining capacity; never fabricate provider token or monetary usage.

## Decision impact and freshness

The [context contract](context-decision-contract.md#late-discovery-and-decision-review)
owns reconsidering decisions. Knowledge owns the dependency frontier below; a
frontier event proposes affected work, while the executor alone changes run state.

### Incremental invalidation

Source revisions, withdrawals, expiry, environment changes, skill repins, policy
changes, and compiler-recipe changes can invalidate derived knowledge. Maintain a
reverse dependency index keyed by exact source revisions and the logical identities
whose current state matters. A record can be historically correct and presently
inapplicable; retain both facts.

Every current-use query compares the record's dependency vector with current
visible heads, expiry, and revocations. A mismatch returns stale/unresolved data or
omits it with an explicit reason. This check is required even while the background
impact traversal is incomplete; an asynchronous index update cannot create a window
in which stale knowledge is presented as current. Historical queries retain their
explicit as-of semantics and cannot be used as action authorization.

Persist the change event and resumable traversal frontier. Default impact batches
visit at most 128 records and 256 edges, recording the frontier when either limit
is reached. Deduplicate by event and dependent revision. Expose `impact_pending`
until traversal finishes; an incomplete index or unresolved endpoint produces
unknown coverage, never a clean bill of health.

Invalidate derived assertions and mark dependent decisions for review; do not
rewrite evidence, erase successful attempts, or reopen unrelated DAG branches.
A fresh computation may reaffirm, replace, or withdraw a claim. Its new revision
links the prior revision and the new supporting evidence. Human or model-authored
corrections remain proposals until their required review path completes.

A proposed contradiction creates an advisory finding. Only a validated source
change, reviewed policy conflict, or other configured authoritative condition may
block a required action. Untrusted notes cannot manufacture a mandatory rule or an
unbounded denial-of-service by alleging conflicts.

## Knowledge health and inspection

### Deterministic checks and optional semantic review

Run health checks over an explicit revision vector and caller scope. The first
implementation checks missing source bytes, broken references, invalid endpoint
kinds, dependency cycles, source drift, stale prerequisites, expired facts, invalid
verification receipts, duplicate lineage counted as corroboration, and incomplete
publication/coverage records. Exact typed contradictions can be detected without a
model when subject, predicate, conditions, and validity intervals are comparable.

Semantic contradictions, missing explanations, and possible connections are model
proposals, not deterministic failures. Optional semantic lint uses the same bounded
compiler job machinery with its own approval and budgets. It cannot initiate web
research, repair production, rewrite instructions, or approve its own findings.

Findings contain a fixed code, severity, affected IDs, bounded safe explanation,
evidence, and suggested disposition. Use `error` for integrity failures, `warning`
for actionable freshness/coverage issues, and `advisory` for semantic proposals.
Report visible inspected/omitted counts and unresolved coverage without revealing
private IDs or private counts. Reports are `clean`, `findings`, or `incomplete`;
clean applies only to the named scope and checks. Dismissal preserves the finding and records a reason;
it cannot clear an underlying mandatory integrity check.

Checks run explicitly at first. Later idle scheduling requires a separate opt-in
and bounded batches; it never silently consumes a model budget. Known invalid
records cannot be used merely because a health scan has not yet run.

### Human-readable projections

Provide an explicit local export of committed, scope-filtered knowledge as Markdown:
an index, resource/concept pages, applicable procedure references, source citations,
conflicts, and a chronological change log. Display evidence status, validity,
coverage, exact revision, and provenance beside claims. Pages must not collapse
contradictory assertions into an unsupported consensus.

Export into a new revision-specific directory selected by the operator. Validate
paths and exclude traversal, redirected files, and unowned existing destinations.
Publish the projection manifest last. A failed export does not change knowledge
heads. Renderers escape active HTML and unsafe links; viewing a citation never
fetches it or executes source content. Obsidian-compatible links are optional.

Exports are disposable views. Edits are not ingested automatically; an explicit
import would create a new untrusted source under the normal review rules. Project
exports exclude session-private and run-private records and their relationship
closure. Run exports require an explicit export policy, current membership/role
checks, and a separate scoped destination; run membership alone grants no export
right. Session-private exports also require an explicit destination and scope.
Hidden evidence must not be exposed through backlinks, titles, counts, or omission
explanations. Revocation prevents future exports; it cannot erase delivered files.

Store a projection manifest binding files to exact source heads so stale exports are
recognizable. The external viewer may still show old text; it is not a permission
source. No Markdown page duplicates the authority of the environment database or
trusted skill artifacts.
Rendered page bytes are deterministic for the same source heads and renderer.
Export execution time belongs in a separate receipt and is excluded from the
rendered-content digest; it must not make unchanged pages appear to have changed.

A later MCP adapter may expose existing scoped search, read, explain-selection, and
health operations. It is a transport adapter over the same resolver, not another
store or unrestricted filesystem server. Graph visualization and embeddings remain
optional consumers of derived indexes and are not prerequisites for this release.

## Integration and first acceptance

The compiler uses the [execution contract](execution-recovery-contract.md) for
admission, terminal evidence, effect uncertainty and budget lineage. Its unit
states describe publication, not a second worker lifecycle. An explicit approved
replacement must still meet that shared safety boundary; approval cannot make
unknown effects disappear. Historical skill auditing retains its existing
full-coverage/promotion rules even when general knowledge compilation reports
partial coverage.

The [coordination contract](coordination-improvement-contract.md) owns run
membership and publication audiences. Every record and source closure is checked
against current membership, scope and approval at read and publication time.
Knowledge-health findings use the shared diagnostic envelope but do not schedule
execution or impose model-generated policy.

For umbrella V1 Phase 1, implement only exact source/prerequisite resolution,
existing trust-policy validation, minimal durable binding references and source
drift/revocation checks needed by the context contract. No full environment import,
compiler, new promotion workflow or database epoch is a prerequisite. If an
installation has no valid trusted source, its bootstrap must establish one through
the operator-controlled boundary before that source can supply instructions.

The subsequent knowledge/bootstrap slice covers reviewed import, an operator-declared procedure, one
captured observation, contradictory/expired facts, revoked approval, explicit
alias mapping, and a dependency change that invalidates only affected work.
It requires neither a large pre-existing skill corpus nor embeddings.

V1 approval acceptance covers read-only preview, approval without activation,
foreign project/session, changed digest/scope/policy, revocation, legacy migration,
policy removal, and restart continuity. Tests exercise real local records, not an
`isHuman` flag. They attest application checks only; hostile same-user store or code
rewrites are outside this boundary. No mandatory-rule engine is introduced here.

Later compiler acceptance adds duplicate intake, malformed but terminal output,
unknown dispatch, crash after head publication, private evidence closure,
bounded partial coverage, exact helper drift, lineage cycles and offline restore.
Run the shared [fault and endurance profiles](coordination-improvement-contract.md#local-long-horizon-acceptance-profiles)
only for the declared implemented increment; do not claim live effectiveness
from injected responses.
