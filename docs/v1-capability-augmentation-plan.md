# V1 capability augmentation and superiority plan

Status: design for implementation review, 13 November 2026. Baseline: PR #14 at
aec6f2d, runtime/package candidate 0.5.12. No implementation, model cohort,
release, merge or V2 work is authorized by this document. Historical trial
rules, failures and scores remain immutable.

## Objective and claim

Make ALG more reliable than native Build at completing difficult, evidence-heavy
work: semiconductor defect investigations over an incomplete datalake map;
coordinated changes across repositories, APIs and databases; and long tasks that
must preserve procedures, evidence and progress through compaction, restart and
handoff. Correctly identifying that available evidence cannot resolve a question
is useful only when the task permits that outcome and an independent evaluator
confirms the missing evidence. Repeated abstention is not superiority.

The intended advantage is retained, decision-relevant state plus better
allocation and verification of work. Additional model effort is acceptable when
it improves independently verified completion. Time, tokens and money remain
reported costs; they are not substitutes for correctness.

A future claim must name workload, model/configuration, host, candidate revision,
resources, uncertainty and limitations. Model-agnostic code does not establish
model-independent benefit. No universal superiority claim is planned.

## Relationship to existing contracts

This is the current prospective augmentation sequence within the
[design index](alg-v1-design-index.md). It extends the
[capability-first comparison plan](v1-reliability-and-build-comparison-plan.md),
[large investigation design](alg-v1-large-data-investigation-design.md) and
[graph/adversarial design](v1-graph-evolution-adversarial-review.md).
The existing context/decision, knowledge/environment, execution/recovery and
coordination/improvement contracts retain their ownership boundaries.

The [action-evidence evaluation](v1-evidence-recovery-evaluation.md) retains
authority over its already issued diagnostic. Its failed V4 pair stays failed;
the locally qualified V5 apparatus and sixteen-arm development cohort remain
unissued. This plan does not reopen either. Future experiments require a new
versioned protocol and frozen issuance manifest.

Use the current DAG executor, immutable task contract, run/attempt artifacts,
root task allowance, session checkpoint, workspace requirements and skill
approval, action evidence, investigation ledger and datalake-mcp adapter.
Extend their typed records; do not introduce a second scheduler, graph database,
vector store, permission interpreter or shared-brain service.

## Baseline: present mechanisms and unresolved behavior

| Present implementation | Remaining capability gap |
| --- | --- |
| Task admission, criterion evidence declarations and before-child baselines | A planner can still misunderstand a requirement or select insufficient proof |
| Authenticated action records, pinned producer submission and mechanical checker consistency validation | The model must still describe verifiable facts consistently; the host currently vetoes contradictions rather than constructing mechanical decisions |
| Session checkpoints, complete active skill delivery, normal-turn and compaction hooks | Durable storage and delivery do not establish that the next action uses the right skill or avoids rediscovery |
| Investigation work identities, assigned work, job reconciliation, bounded result reads and validity checks | Actual datalake-mcp integration remains unqualified; incomplete coverage and semantic aliases still require judgment |
| Immutable graph revisions limited to unattempted pending work; fixed managed investigation graph | Automatic selection and measured promotion of superior graphs are not established |
| External live-obligation evaluation in the long-session benchmark | This is measurement apparatus, not proof of a general production obligation engine |
| Local Windows/PowerShell and Linux/Bash qualification | Successful installation and deterministic lifecycle tests do not establish hard-task capability |

The latest real-model diagnostic could not finish the independently correct
case with a valid passing checker output. Its defective case was substantively
rejected but failed the frozen retrieval recipe. The historical Luna continuity
comparison was Build 1/8 whole tasks and ALG 0/8, on two underlying development
incidents. Neither constitutes superiority. See
[current receipts](evidence/checker-consistency-20261113/README.md) and the
[comparison protocol](v1-evidence-recovery-evaluation.md).

## Architecture: one task, several explicitly owned views

Keep one host-owned task identity and original requirements through every phase.
A phase run, investigation, graph revision and handoff point back to that task.
All views carry revision/digest references; context is a disposable projection.

| View | Owner and augmentation |
| --- | --- |
| Requirements and verification plan | Extend task-contract/evidence-plan records with explicit decision authority and observation dependencies |
| Live obligations | Extend existing run details with bounded criterion-linked obligations; checkpoint stores a head/reference, not another mutable copy |
| Environment and procedures | Existing workspace facts, environment records, exact approved skill closures, operation scope and revocations |
| Investigative knowledge | Existing investigation checkpoint: hypotheses, contrary observations, coverage, source validity and jobs |
| Actions and outcomes | Existing native action journal, immutable artifacts, admitted remote work and results |
| Coordination and learning | Existing DAG revisions and candidate/evaluation records; proposals never certify themselves |

A minimal obligation references its task, criterion, owner node, dependency
digests, required observation/skill, state, evidence references and bounded next
action. Proposed states are open, awaiting_evidence, awaiting_review, satisfied,
contradicted, blocked and invalidated. Transition receipts record why and which
evaluator/source justified the change. A model statement alone cannot mark a
mechanical obligation satisfied. Semantic findings retain their model judgment
and evidence provenance rather than acquiring a label of objective truth.

Reuse the current criterion count, artifact byte limits and revision-fenced
persistence. If more obligations are needed than the bounded phase permits,
create explicit linked phases under the same task and allowance. No unlimited
checklist, silent eviction, or new task identity to replenish resources.

The run-state revision is the authoritative obligation commit point. Write and
verify immutable obligation details before atomically committing their reference
under the existing run lease; only then publish the root checkpoint's derived
pointer using its expected revision. This is not a distributed transaction.
An interrupted pointer publication leaves a valid run revision discoverable
through the existing active-run index. Resume repairs a stale pointer from that
revision; a pointer to absent, mismatched or future material blocks dependent
actions and is never accepted as authority. Orphan uncommitted details cannot
advance an obligation. Do not roll back a newer checkpoint to publish an old
view. Reconcile allowance reservations by their existing idempotency keys before
dispatch; neither pointer repair nor a replayed transition refunds work.
Test crashes before/after each detail, run-head and checkpoint commit, including
concurrent publication and cancellation. Avoid nested cross-store lock ownership.

## Phase A — make verification finish correctly

### A1. Freeze criterion authority before work

Add a versioned verification contract to new qualified admissions. Each original
criterion has one of these modes:

- Mechanical: a supported host evaluator can decide the entire criterion from
  declared observations.
- Semantic: a fresh checker must assess meaning, sufficiency or causality.
- Mixed: named mechanical predicates and a substantive judgment are both required.

Bind the original criterion text/reference, evaluator version, expected predicate
arguments, required source scope and evidence adequacy to the admitted contract.
Worker output cannot select an easier evaluator, remove a predicate, replace the
expected value or change the mode. Keep host expectations separate from observed
records. Prefer shipped typed criterion recipes for routine checks. Free-text
requirements default to semantic or mixed unless their complete mechanical
mapping can be justified.

Structural validation cannot prove faithful natural-language translation.
Retain the original request, check coverage before dispatch, and evaluate
translation errors with independent cases. Ambiguous material requirements
remain unresolved for clarification; routine typed requirements need no new
human approval step. A request outside a recipe cannot be silently narrowed.

Example: a linked captured command with reported exit zero satisfies that
execution predicate. It does not establish test relevance, a bug fix, an API
contract or a causal explanation.

### A2. Construct decisions from the correct authority

Refactor the existing mechanical evaluator to return typed predicate findings
with provenance rather than only an error string. It consumes authenticated,
submission-bound records; model summaries are not substitutes. Preserve
complete-byte coverage, linkage, truncation/redaction, freshness and scope rules.
Missing, stale, conflicting, unbound or insufficient observations remain unknown
or an integrity failure. A well-observed predicate violation is false.

The host constructs mechanical criterion results and the final aggregate.
A semantic checker emits only its criterion findings, citations and bounded
rationale; it need not regenerate an aggregate Boolean already determined by
those findings. All mandatory components must pass. An unknown component blocks
verified completion; a failed component rejects it. Keep artifacts produced,
verification completed and user task completed as distinct outcomes.

For mixed criteria, expose mechanical observations with their limited meaning to
the semantic checker. Disagreement over substantive adequacy stays substantive.
Do not turn a producer's success assertion or a passing test command into a
whole-task pass.

For a new contract containing only fully mechanical criteria, the existing
checker execution boundary records a host-evaluated verdict without launching a
model just to repeat those results. Record evaluator/source identities and actual
host work; do not invent a child session or charge an unissued model dispatch.
Mixed/semantic contracts retain the fresh child review and its allowance
reservation. This is a versioned execution-path change requiring explicit
admission and migration tests, not a relaxation of legacy checker requirements.

Version the output and persisted verdict contracts. Legacy boolean checkers and
optional mechanical assessments remain readable with their original authority;
do not reinterpret historical failed attempts or synthesize missing proof.
Validate both live output and reload/resume through the same evaluator.

### A3. Repair the smallest failed unit

| Failure | Permitted recovery |
| --- | --- |
| Invalid checker shape or contradictory generated fields | Bounded checker-only repair; fixed codes, host-assigned criterion IDs and bounded authenticated predicate facts |
| Missing post-work observation that can still be collected | Admitted observation-only probe; retain the producer output |
| Missing original baseline or expired irreplaceable evidence | Honest blocker; no invented baseline or replay to manufacture historical proof |
| Valid substantive rejection | Explicit feedback to the responsible producer, then a fresh review of its new submission |
| Remote outcome unknown | Existing lookup/reconciliation before resubmission; retain charge and lineage |
| Changed inputs, source or skill authority | Invalidate dependent obligations and replan permitted follow-up under the same task |

Feedback uses allowlisted keys/values and typed expected/observed facts; never
echo arbitrary child keys, raw diagnostics, credentials or hidden grader truth.
A valid rejection is not eligible for repeated checker sampling until one passes.

An observation probe needed after an attempted checker cannot be inserted by
rewriting that checker. Add a bounded successor-phase admission using existing
plan/run records: expected root-task revision, prior run/submission/obligation
digests, fixed original criterion IDs, repair classification, new evidence or
changed submission identity, proposed observation/repair nodes, imported evidence
references and nominated fresh verification. Admission verifies the same owner
and unfinished task, preserves requirements/scope, authenticates imported sources
and their validity, and reserves from the original root allowance before launch.
Use a host-derived admission key so a crash/repeated request finds the same
successor rather than creating another. Preserve the prior failed run and all
attempt charges. A successor cannot exist solely to resample a valid substantive
rejection: it needs an admitted missing observation or a changed producer result.
An actually completed root task cannot be reopened through this route.
Checker-only schema repair remains within its original attempt allowance.

**Implementation surface:** task-contract.ts, verification.ts,
checker-consistency.ts, task-evidence.ts, sessions.ts, executor/store hydration,
schemas/types and checker instructions. Keep a small pure evaluator; filesystem
and receipt authentication stay with their existing owners.

**Exit A:** local positive/negative/unknown/forged/stale/partial evidence fixtures
and reader migration pass on both platforms; a separately frozen real-checker
diagnostic demonstrates correct decisions and recovery without producer replay.
Require all diagnostic classes to work, not just one successful positive. Report
attempts and false accepts/rejects separately. No cohort launch after a failed
diagnostic, and no repeated paid replay under the same issuance.

## Phase B — make recovered state drive the next action

Derive initial obligations from the admitted contract, evidence plan, approved
skill applicability and investigation work orders. Update them transactionally
from existing action/result receipts and review outcomes. Preserve semantic
hypotheses as claims with sources, not mechanically verified world facts.

At new-session/attach, pre-delegation, managed query admission, explicit resume,
normal-turn context delivery and compaction recovery:

1. Resolve task, environment, exact graph revision and active phase.
2. Revalidate relevant skill approvals, operation scope and evidence validity.
3. Reconcile pending/unknown jobs before admitting equivalent work.
4. Select unresolved obligations and valid reusable results.
5. Publish a bounded next-action view with exact retrieval pointers.

The working view includes the original goal/criteria pointer, current obligation,
required complete skill instructions, completed compatible work, material
contradictions, pending jobs, freshness gaps and next admissible action.
Use existing context-budget and delivery receipts. Allocate mandatory procedure
content first; page optional evidence and map fragments. If complete required
instructions do not fit, split the work or report needs_context. Do not replace
them with an abbreviated summary while claiming the skill was loaded.

Avoid run-history scans or model calls on every hook. Use active task indexes,
revision changes and cached verified projections; revalidate at action admission
where freshness/authorization matters. Context delivery is not proof of skill
use: measure the observed downstream action separately.

For ALG-controlled dispatch/query boundaries, enforce an obligation/work-order
reference and compatible-result lookup. For native root tools whose operation
semantics cannot be reliably observed, describe coverage as advisory. Do not
claim universal prevention of repeated shell commands or hidden API calls.

Record stale/superseded evidence and which obligations depend on it. Keep valid
siblings. Completed nodes are not reopened by modifying their history: use
existing feedback where allowed, or an explicit successor phase linked to prior
results and the original allowance. Current pending-node revision rules remain.

**Implementation surface:** session-memory schemas/runtime/context/delivery,
context-budget.ts, index.ts hooks, operational-runtime/tools, workspace runtime,
executor, existing run detail persistence and investigation admission.

**Exit B:** local crash/concurrency fixtures cover every commit/dispatch boundary.
Actual headless Windows and Linux hosts preserve obligation identity, skill
revocation, pending jobs and cumulative allowances through compaction, restart
and authorized handoff. Behavior checks show continued correct work and no
duplicate compatible expensive submission. Missing follow-up remains unknown.
Do not equate a stable hash with retained understanding.

## Phase C — qualify a useful investigation and collaboration workflow

### Incomplete datalake and semiconductor investigations

Qualify the real datalake-mcp schema, principal scope, source versions, job
identity/lookup, result pagination, validation and cancellation semantics before
claiming deployment integration. While it is unavailable, implement and test
against qualified synthetic service fixtures and ship a non-secret offline
qualification recipe. A mock pass is not real-service acceptance.

Reuse Polars, DuckDB, Arrow, Parquet and S3 through the service. ALG stores only
bounded observations, lineage and result/job references. Search progressively:
map/domain candidates, metadata and join feasibility, bounded cohort analyses,
then discriminating tests. Unknown map coverage is unknown; absence from the map
does not prove absence from the lake.

Each work order states its question, cohort/grain/time basis, recipe/version,
source dependencies, expected evidence, cost reservation and stop condition.
Before interpreting a signal, check timestamp alignment, entity keys, join
cardinality, missingness, sampling changes, leakage and source dependence.
Record explored families, null findings and contrary results.

For a defect hunt, distinguish equipment/process exposure from product mix,
inspection changes, maintenance timing, shared material batches and log gaps.
A causal conclusion requires the declared causal evidence; correlation or feature
importance alone supports a narrower finding. Preserve a held-out period/cohort
for confirmation when appropriate. An engineer contribution is attributed
reported knowledge until independently supported.

### Small-team, multi-repository work

Reuse the workspace registry and Git-backed team procedures. A task-scoped
dependency view records repository commit/branch, API/schema compatibility,
migration ordering, owner and verification commands. Give a partner the same
versioned procedures and project references; credentials stay outside handoffs.

Current evidence is rooted in one project directory. The first multi-repository
increment therefore uses one explicitly authorized workspace root with at most
eight contained repository checkouts and the existing total file/byte limits.
Extend the task/evidence contract with typed repository bindings: registry ID,
contained root, repository/worktree fingerprint, base commit and dirty-content
snapshot, project-relative deliverable path, producer and verifier. A repository
name supplied by a model cannot authorize a filesystem root. Check containment,
symlink/alias collisions and per-repository scope before baseline collection;
bind every action/result to its repository. Recheck source heads and relevant
content before reuse and aggregate completion. Changed inputs invalidate their
dependents, not all repositories.

Out-of-root checkouts require a separately qualified authorized-root adapter;
they are unsupported in this first increment rather than silently scanned.
Database migration IDs, schema versions and API contract revisions are separate
evidence bindings: a Git commit is not proof of database state or service rollout.
Tests must cover same-named files in different repositories, dirty worktrees,
source drift, symlink escapes and a missing cross-repository integration check.

Parallel branches use isolated checkouts and explicit write scopes. A shared
database migration or incompatible API change is a dependency with an owner,
not two independent worker tasks. Re-read relevant Git/source heads before
reusing evidence. A handoff records remaining obligations and accepted commits;
it does not infer distributed ownership or acquire new credentials.

Local ALG leases do not coordinate different machines. Shared migration/job
exclusivity needs an existing Git/service/team mechanism. If none is available,
serialize that operation explicitly. Do not build a consensus service for V1.

**Exit C:** representative synthetic factory and multi-repository workflows reach
independently graded results, preserve valid work on partial failure and recover
from source drift/handoff. Report real datalake-mcp qualification separately.

## Phase D — spend extra reasoning where it helps

Build an inspectable selection rule on task discovery needs and unresolved
obligations, not model names:

- Known change and adequate criteria: compact producer plus fresh verification.
- Missing evidence or competing explanations: bounded discovery, then synthesis.
- A material claim vulnerable to a plausible alternative: one targeted
  falsification probe using a different method or evidence path when feasible.

An adversarial probe names the claim, alternative explanation, observation that
would discriminate them, allowed resources and stopping rule. It is an ordinary
bounded research node before synthesis. The final checker remains separate.
No requirement to invent a defect, no voting-to-truth, no recursive reviewers.
Agreement from agents reading the same source is not independent corroboration.

Before extra work, record which unresolved obligation it can resolve. Stop
repeating actions with unchanged inputs/evidence; permit justified independent
verification and host-admitted refresh. Track no-progress loops by durable action
identity and obligation revision, not identical prose or model confidence.

Keep the managed investigation template fixed in the first delivery. Evaluate
selection and probe placement on existing allowed templates first. Parameterized
managed variants need their own policy qualification before activation.

Model-authored candidate graphs may then use the existing proposal/validation
path. Pin candidate digest, applicability, criteria coverage, skill/environment
requirements, verifier and bounds before evaluation. Preserve current immutable
attempts, pending-only revisions, root allowance and ownership. No self-awarded
budget, rewritten criterion, completed-node edit or active-run promotion.

Compare candidate/incumbent on development and untouched evaluation cases.
Promotion eligibility includes regressions, semantic accuracy, mechanical failure,
duplicated work and total effort. The harness may apply a scoped approval under
already delegated application policy; it cannot approve outside that policy,
judge its own hidden holdout or rewrite evaluation evidence. Preserve candidate
lineage, activation scope, rollback and revocation. Publication and executable
helper deployment retain their existing authority.

**Exit D:** paired normal-review versus targeted-adversary cases identify both
benefits and costs, including unnecessary objections on correct work. Candidate
promotion cannot change active runs or bypass criteria and permissions.

## Phase E — measure superiority without manufacturing it

Develop the evaluator alongside Phase A; do not wait until the product looks
successful. Existing development cases are debugging material, not confirmation.

### Qualified measurement

Use independent reference solutions, negative and tampered outputs, missing
evidence and source-change controls to validate every scorer. Public requirements
must fully describe the success contract; hidden data may test generalization,
but hidden formatting requirements cannot invalidate otherwise correct work.
Test retrieval integrity separately from exact navigation recipes unless that
recipe is itself a public requirement.

Hold expected answers and graders outside agent-visible tools/workspaces.
Same-account path separation alone is not a security boundary; inspect actual
agent-accessible surfaces, preserve access logs and mark contaminated trials.
Do not let either arm see ground-truth labels, fixture fault selectors or the
other arm's output.

Historical factory cases also freeze an original decision-time cutoff and an
inventory of every observable source: raw records, map revisions/enrichment,
skills, logs, schema corrections, postmortems and engineer contributions.
Exclude later knowledge even when it does not explicitly contain the answer.
Both arms receive the same reconstructable as-of view. If that view cannot be
reconstructed, label the replay hindsight-assisted development evidence, not
blind confirmation. Fresh synthetic cases likewise keep fault-generation truth
and future enrichment outside exposed service metadata.

### Development, rehearsal and confirmation

1. Qualify deterministic mechanics locally and real-checker behavior separately.
2. Run a finite diagnostic development batch; retain every failure and repair
   against new variants. It supports design learning, not a final claim.
3. Rehearse the complete runner, accounting and recovery with a frozen small
   cohort. Use it to estimate independent-incident variability and feasibility.
4. Freeze candidate, tasks, scorer, service, skills, host/model configuration,
   resource ceiling, order/randomization, exclusions and statistical analysis.
   Select a confirmation size by power/precision analysis at the incident level.
5. Issue fresh holdout pairs once under that protocol. A failed or inconclusive
   cohort is reported as such. A changed candidate requires a new prospective
   cohort, with the earlier result retained.

Cover long factory investigations, coordinated API/database/frontend work,
compaction/restart/handoff and ordinary short controls. Include resolvable and
correctly unresolvable incidents. Difficulty comes from realistic dependencies,
confounding, incomplete evidence and duration, not sabotaged Build permissions
or ALG-only access to useful data.

Give both arms the same underlying tools/data, skill content, public requirements,
model configuration and external resource ceiling. Build retains native planning,
delegation and checkpointing; ALG state organization and enforcement are the
treatment. Pin profiles and prevent cross-arm caches/state leakage. Total effort
includes root, workers, checker repairs, probes, summaries and failed work.
Report unavailable provider usage/billing as unavailable, not zero.

Offer generous finite headroom justified by reference feasibility and the intended
workflow. No arm-specific extensions or resetting allowances through handoff.
Keep failed, stopped, unavailable and unstarted cells visible under predeclared
denominators. Report assigned and actually started counts; operational failure
cannot be quietly discarded to improve completion.

### Scorecard and claim rule

| Measure | Definition/use |
| --- | --- |
| Verified whole-task completion | Primary: all public hard criteria independently satisfied; all issued outcomes retained |
| False acceptance and rejection | Unsafe/unsupported accepted results and correct work incorrectly rejected, with appropriate denominators |
| Obligation retention | Correct latest pre-transition obligations with unchanged truth: retained, regressed and unknown after the transition |
| Expensive work reuse | Compatible accepted computations reused; avoidable duplicate submissions distinct from legitimate independent verification |
| Recovery | Time and new work needed after a defined interruption; invalidated versus preserved results |
| Failure attribution | Admission, extraction/schema, evidence retrieval, checker interpretation, real defect, service, resources and runner faults |
| Effort and context | Wall/active time, reported usage and coverage, remote work, context bytes, store/resource growth and cleanup |
| Procedure use | Observable compliant actions and explicit reminders per applicable task, not just skill-load events |

Observe automatic compaction at native configured capacity on naturally long
tasks. Do not pad context or shrink capacity to manufacture it. Record root and
child events, requested versus natural summaries, completed exposure, tokens
when available and active duration. Report rate per active hour and per measured
usage with missingness. If no natural compaction occurs, that claim remains
untested.

Freeze externally observed obligations before each transition. Distinguish
initial mistakes, changed truth, absent follow-up and actual regression. Test
behavior requiring the information, not copied summaries. Handoff and restart
are separate exposures. Do not pool many obligations or cells from one incident
as independent replicates; descriptive before/after loss is not automatically
a causal effect of compaction.

For a narrow superiority claim, predeclare a practical completion gain (proposed
starting target: at least 10 percentage points) and require an uncertainty
interval excluding zero, using an incident-aware paired analysis. The precise
threshold, sample size, interval and stopping rules must be frozen before
confirmation. Repetitions of two incidents cannot support a broad claim.

Also predeclare acceptable false-acceptance and regression margins with sufficient
precision. Zero observed serious errors in a tiny cohort is not a zero-risk
guarantee. Report primary and safety/quality outcomes together; a gain obtained
by accepting unsupported work is not acceptable.

Use targeted ablations after mechanics work: ALG without durable recovery, ALG
without the adversarial probe, and where feasible Build with comparable extra
reasoning headroom. These explain whether gain comes from memory, verification,
work allocation or extra compute. Do not weaken public safety/correctness
criteria for an ablation. Analyze workload groups and models separately before
making broader claims.

## Delivery order, gates and first implementation slice

| Package | Dependency | Concrete reviewable deliverable |
| --- | --- | --- |
| A0: freeze authority and evaluator contract | Design review | Versioned schema, truth table, migration and positive/negative scorer fixtures |
| A1: host-derived mechanical findings and aggregate | A0 | Pure evaluator, authenticated bindings, reader/live parity and focused local tests |
| A2: cause-specific repair | A1 | Bounded checker repair/probe routing with no producer replay or semantic resampling |
| B1: obligation state and compact recovery | A1 | Existing-store extension, transactional transitions and context/skill selection |
| B2: action-time reuse and invalidation | A2 + B1 | Managed admission checks, job reconciliation and actual-host behavior receipts |
| C1: domain qualification | Parallel discovery; uses B2 | Typed repository evidence, synthetic workflows, as-of source inventory and separately scoped real-service qualification recipe |
| D1: selective probes and graph candidates | C1 local qualification | Fixed selection rules, adversarial comparisons and candidate provenance |
| E1: comparative development/confirmation | A-C gates; D if included | Frozen runner, holdout protocol, incident-level analysis and honest scoped result |

Start with A0-A2, not a new memory backend or recursive orchestration. Keep
changes reviewable: verification contract/evaluator, recovery integration,
obligation projection/admission, domain workflows, graph improvement and
evaluation are separate increments. Share the original task and observation
formats across all of them.

A0 must resolve the exact evaluator vocabulary, authority mapping,
unknown/conflict semantics, version compatibility and local acceptance matrix.
A1/A2 must prove that correct mechanical work can finish without a model
repeating deterministic facts, while genuinely bad or inadequately evidenced
work remains rejected/unresolved. Only then commission a new real-model
diagnostic; freeze its scope and bounds before execution.

Every implementation increment updates its status with exact source/runtime
identity, local tests and known limitations. Run affected local tests and
typecheck, then required Windows/PowerShell and Linux/Bash host acceptance.
Final package changes require fresh/update/relocation verification on both.
Do not rerun broad suites or paid cohorts without a changed risk or new gate.

PR merge readiness, deployment readiness and superiority are separate decisions.
Engineering may qualify without a superiority claim; that must be explicit.
This plan does not authorize merging PR #14.

## Scope limits and decisions that remain empirical

V1 only, model agnostic, local testing only, no GitHub runners or user-global
configuration changes. No Grok or local Gemma under current user constraints.
Any future chosen OpenAI model is a test profile, never a runtime special case.

No bulk data in context, cross-user consensus infrastructure, replacement
analytics engine, autonomous production migrations, or recursive orchestrators.
No automatic learning from private transcripts without the existing scoped
authority. Approval, source validity and measured usefulness stay separate.

Real datalake-mcp capabilities, native Linux deployment behavior, confirmation
sample size, practical cost envelope and cross-model generality remain empirical
questions. Resolve them through scoped qualification and measurement rather than
invented capabilities or deadlines. If Build remains better, preserve the result,
identify the failed mechanism and change the next prospective design.
