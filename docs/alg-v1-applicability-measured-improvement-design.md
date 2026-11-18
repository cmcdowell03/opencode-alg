# ALG V1 Applicability and Measured Improvement Design Draft

Draft design for OpenCode ALG V1. Dated 9 November 2026.

ALG helps an agent team work competently in a known environment: resolve required procedures and facts before acting, retain verified work and unresolved questions through context loss, and adopt improvements only when the evidence supports them.

The [design index and roadmap](alg-v1-design-index.md) defines the single delivery order. Phase 1a establishes the shared workspace requirements registry and qualifies the real MCP/model boundary; Phase 1b adds durable managed investigations sized to those capabilities. Measured skill promotion follows when usable cases and candidates exist. Template selection precedes free-form graph authoring. The artifact-building pack remains an optional later extension.

Here V1 means the OpenCode 1 host, not a second numbering system for design generations. These drafts are revised by date. There is no OpenCode 2 implementation, new query engine, hosted service, vector database, always-running model or second scheduler.

Status is draft for review. Configuration shapes and new record names below are proposed contracts, not currently installable options. This document does not authorize implementation, deployments, model spend, or tests on GitHub runners.

## Decisions

1. Retrieval proposes candidates; applicability checks decide whether their declared prerequisites match the current operation and environment.
2. Applicability, source trust, measured effectiveness, publication authorization, activation, context delivery, and tool permissions are separate states.
3. Measurements remain tied to exact skill closures, task fixtures, environments, verifiers, and execution configurations. A passing evaluation establishes only its declared scope.
4. Retained old successes and new improvements are measured separately. Cost savings cannot compensate for a correctness or permission violation.
5. The harness may approve and load eligible skills under existing delegated application policy. That policy does not itself authorize publishing changes.
6. Models may propose declarative graphs. The existing executor validates and executes accepted plans; no competing scheduler is introduced.
7. Automatic routing performs no model calls. Optional learned ranking and autonomous graph revision are later, separately enabled capabilities.
8. Delivery, observable procedure compliance, and verified task outcomes remain separate. Evaluate combinations of selected skills, not only individual revisions.
9. Large data investigations use datalake-mcp for discovery and computation. ALG owns bounded coordination, durable investigation state and evidence references. An incomplete map may improve during use without turning inferred relationships into verified facts.

## Existing implementation and the extension

The design baseline is merge commit [99b88cd](https://github.com/cmcdowell03/opencode-alg/commit/99b88cd051cdff2ac30eff81b5a927d76a826efe). Reconcile implementation changes after that commit before coding against this spec.

| Existing component | What is already available | Extension |
| --- | --- | --- |
| SkillIndex and skill catalog | Bounded discovery and lexical or tool-hint ranking | A pure applicability matcher over scoped facts; ranking remains a discovery aid |
| ALG.json and skill closures | Exact skill and prerequisite hashes, environment and operation declarations | Additive manifest schema for bounded applicability predicates |
| alg_skill and approval policy | Preview, policy approval, explicit loading and repinning | Reuse these operations; surface applicability and measurement status without conflating them |
| Context and session memory | Durable bindings, complete instruction restoration, bounded delivery observations | Restore applicability dependencies and invalidate stale selections |
| Experience store and evaluateSkill | Immutable outcomes, version and environment provenance, paired comparisons, leakage checks | Versioned evaluation plans, execution receipts, protected-case coverage and enforceable promotion eligibility |
| Skill publication transaction | Checker approval, drift checks, backup, journal and rollback | Check required measurement eligibility inside the common publication function |
| alg_plan and graph validation | Custom graph_json, structural validation, shell preflight and persisted plans | Evidence-informed proposal workflow and verification coverage |
| Existing DAG executor | Attempts, dependencies, outcome records, budgets and resume behavior | Retain as execution authority; defer new graph-revision behavior until lifecycle requirements are met |

The current evaluator accepts one to thirty distinct task-group pairs and emits eligibility for review. It neither executes replay tasks nor establishes a calibrated population-level success guarantee. Current publication does not require its evaluation record. Those are the principal gaps addressed here.

Private skill-evolution calls still have a documented all-tool permission-transport limitation in the V1 baseline. This design does not bypass it. Applicability and measured evaluation can proceed using existing approved skills and explicitly supplied, reviewed candidates; automatic historical mining is not a prerequisite.

## Contract ownership and reconciliation

This spec is a focused extension of the existing umbrella design, not a fifth competing control plane.

| Existing contract | Responsibility in this extension |
| --- | --- |
| Context and decisions | Structured intent, applicability, selection explanations, delivery and pre-action checks |
| Knowledge and environment | Identity, full revision closures, provenance, approval and revocation |
| Coordination and improvement | Evaluation plans, protected comparisons, improvement proposals and scoped eligibility |
| Execution and recovery | Attempt identity, execution budgets, side-effect reconciliation and permitted graph revisions |

Keep the umbrella's owner boundaries and diagnostic vocabulary. New records reference the authoritative owner instead of copying mutable state into several stores.

For per-skill applicability in Phase 1a, extend the existing adjacent ALG.json format. This is a concrete refinement of the context contract's unresolved frontmatter or sidecar preference. Do not add an additional alg-skill.json format or duplicate frontmatter parser in this increment. Older manifests keep their existing semantics; a legacy unrestricted declaration is not silently converted into a mandatory routing rule.

The incident watcher remains a future intake client of these contracts. It receives no new scheduling authority. No V2 spec or implementation changes are required.

The companion [ALG V1 Large Data Investigation Design Draft](alg-v1-large-data-investigation-design.md) applies these same four contracts to a semiconductor defect hunt. It defines the datalake-mcp boundary, progressive map discovery, durable hypotheses, delegated work and analytical verification. It introduces no fifth control plane. Local readiness can ship before the full investigation profile; measured promotion follows the shared roadmap.

## Identity and evidence

A skill revision identifies the complete instruction closure: SKILL.md, its manifest when present, every declared prerequisite and the canonical manifest schema. Hashing preserves exact instruction bytes. Use existing canonicalization and source identity helpers.

Existing skill-content hashes and full-closure hashes are distinct types. Retain both where adapting old evaluation records; do not silently reinterpret a historical content hash as a closure hash.

An applicability result is bound to project and caller scope, task epoch, phase, operation and resource identities, environment revision, skill closure, relevant policy-rule digests, and the revisions of facts used in matching. Identical names in different repositories or environments are distinct until an explicit mapping resolves them.

Evidence retains source, observation time, verification method, validity scope, expiry or invalidation conditions, and supporting or refuting references. Unknown, missing, stale, conflicting and incompatible are distinguishable. Repeated summaries of the same source do not count as independent observations.

Model-authored relationships remain proposals. They cannot establish trusted resource identity, mandatory procedures, access rights or a successful evaluation.

## Applicability checks

### Inputs and rules

The matcher consumes a bounded structured intent and a scoped snapshot of facts. Intent includes task phase, operation ID, resource IDs, environment identity, role, and fixed diagnostic codes. A plain continue request derives this context from the persisted task and next step.

Begin with exact environment, resource, operation, role and phase predicates, known compatibility ranges, and declared prerequisite revisions. Missing version information is unknown, not an implicit match. Avoid arbitrary expressions, manifest code, unrestricted regular expressions and inferred credentials. Path and command classification remain advisory until an explicitly supported adapter can resolve their semantics safely.

A manifest may declare where a procedure is applicable or unsuitable. It cannot grant itself trust or mandatory status. A required procedure needs a separate operator-controlled routing-policy rule, bound to the trusted source and permitted operation/resource/environment scope. Existing skill-load approval policy alone does not authorize mandatory routing.

Use this order:

1. Resolve caller scope, identity, approval, revocation and source integrity.
2. Resolve explicit pins and separately authorized mandatory requirements.
3. Check complete prerequisites and facts used by those requirements.
4. Discover optional candidates through the existing catalog and reviewed resource links.
5. Evaluate applicability and then rank compatible optional candidates deterministically.
6. Prepare complete instruction closures under the existing context budget.

Fuzzy matches and inferred edges are candidate signals only. An exclusion in one skill cannot override another authoritative requirement. Conflicting required rules return a conflict rather than choosing a higher score.

### Result semantics

| Result | Meaning | Effect |
| --- | --- | --- |
| applicable | All declared predicates needed for this scope match current evidence | Eligible for selection; approval, delivery and host permissions still apply |
| incompatible | A known fact contradicts a declared predicate | Exclude this candidate for the operation |
| unknown | A required fact, identity mapping or discovery segment is unavailable | Show the gap and bounded next discovery action |
| stale | A used source or environment revision expired or changed | Recompute before relying on it |
| conflict | Authoritative facts or required procedures disagree | Block the affected covered operation pending resolution |

The aggregate router retains the context contract's required, recommended, excluded and unresolved lists, with ready, needs_skill, needs_context, conflict or coverage_unknown status. Each item exposes exact revision references, fixed reason codes and a short match path.

A valid empty selection means no match within the declared, completely checked scope. It does not mean no relevant procedure exists anywhere. Unknown applicability for an optional candidate does not block unrelated work; an unresolved authoritative requirement blocks only its covered operation.

Applicability does not imply empirical effectiveness. Surface measurement status separately as unmeasured, supported for the named evaluation scope, failed for that scope, or inconclusive. Never turn a relevance score into a probability that a procedure will succeed.

### Shared workspace requirements registry

Use one proposed per-workspace file, .opencode/ALG.workspace.json, for readiness and applicability. A workspace maintainer authors it in version control; the harness may propose edits under normal repository policy. It lists known operations, resource identity, required skill/document/fact references, authoritative source locations, freshness rules, verifier IDs and supported adapter coverage. It contains references and declarative bounded predicates, not embedded credentials, arbitrary scripts or a second policy engine.

This workspace registry describes what an operation needs. Existing per-skill ALG.json continues to describe a skill's applicability and prerequisites. Existing operator approval policy decides which source and scope may be trusted or made mandatory. A workspace file, inferred map edge or model cannot grant itself that authority.

Seed the registry from reviewed examples of this team's Git publication, migration preparation, test gates and data investigation. Candidate operation names are repo.publish, data.migration.prepare, repo.test and data.investigate.read. Start with advisory readiness for operations whose actions cannot be safely identified; enable enforcement only at a qualified ALG-owned boundary. Merely adding a name does not implement a Git or migration adapter. Artifact operations are optional later entries.

A requirement retains its maintainer, source revision, scope and verification basis. Approved team sources may use the existing delegated application policy so the harness can approve and load eligible revisions without repeated operator prompts. A protected-branch review can supply provenance only when required independent review and branch controls are actually enforced and the deployed revision is authenticated under that policy. A merge alone is not a runtime permission grant. Offline ZIP deployments use an explicitly approved revision/inventory through the existing source policy; do not infer current branch protection offline.

On first attach, inspect the registry and declared sources, report missing facts or procedures, and offer a bounded next discovery step. Recheck only dependencies changed since the last decision. This provides minimal partner readiness without cloning repositories, sharing credentials, synchronizing users or introducing a second onboarding subsystem.

### Initial operation and fact contracts

Each operation entry declares its ALG admission boundary, typed input validator, resource resolver, required fact sources, revision or expiry rules, supported effects and checkpoint verifier IDs. Source identity comes from the resolved repository/workspace or scoped datalake-mcp handle; required facts come from permitted local checks or authoritative metadata where available. A model may propose an intent or alias, but an unresolved mapping remains unknown. Inferred or incomplete metadata retains that status.

An adapter must distinguish discovery, bounded reads, remote job submission and writes. A tool name or read-only declaration alone is insufficient evidence of enforcement. No adapter means no claim of mandatory action coverage. Missing facts produce a bounded discovery request or a visible gap; a limited catalog search cannot establish that an object does not exist.

### Skill combinations and precedence

Record the ordered set of selected skill closures, their roles, prerequisite links and the policy revision resolving precedence. Explicit host permissions and operator policy remain authoritative. A required instruction conflict returns conflict; lexical rank or the latest loaded text cannot resolve it. Omit incompatible optional procedures with an explanation.

Evaluate combinations that the router actually selects, beginning with the team's repository/test procedures and data-investigation/environment procedures. The optional artifact profile later adds web-artifacts-builder plus frontend-design. Fixtures cover conflicting dependency commands, incompatible workspace assumptions, missing prerequisite delivery and combined context overflow. A passing individual skill evaluation does not qualify an untested combination. Avoid an exhaustive Cartesian product: qualify named combinations and expose the remaining coverage gap.

## Selection before decisions and through compaction

Run checks at task or operation changes, before graph acceptance or delegation, after relevant environment/source changes, and before covered consequential dispatch. Reuse a revision-keyed result on unchanged turns rather than rereading the full catalog.

First V1 enforcement covers ALG-owned plan/run/resume boundaries and the registered operations those boundaries can resolve. Generic shell, arbitrary MCP calls and unrelated host tools remain outside coverage. The inferred operation of a model proposal cannot override an adapter-observed conflicting operation; ambiguous intent stays unresolved.

When a previously missing required procedure becomes available, deliver its complete closure and require a fresh planning/model step before executing consequential arguments chosen without it. Merely appending instructions immediately before dispatch does not validate the old decision.

The harness may call existing preview, approve and load operations under configured policy. Loading is not publication. Current approved bindings are restored directly after compaction or restart, with applicability and source checks repeated as needed. Request-bound delivery observations are never reused as proof of delivery to a new request.

Keep compact orientation in context: current task and phase, selected skill references, applicability reasons, unresolved requirements, and exact fetch pointers. Selected instructions remain complete. Optional evidence is omitted first; required overflow returns needs_context. Recovery must also work after a missed compaction hook and an empty RAM cache.

Late discovery marks only affected unexecuted decisions for review. Previously executed work is assessed before any replay or rollback. A changed skill does not automatically invalidate every completed node in a project.

### Observable procedure checkpoints

Attach a bounded checkpoint contract to procedures with mandatory operational steps. A checkpoint identifies the exact procedure revision, covered operation, required observation, verifier identity, evidence references and deadline relative to dispatch. Reuse existing attempt and experience receipts; a model assertion that it followed the skill is not proof.

For artifact work, checkpoints may require a verified entry file, successful build and exercised interaction. For a data investigation, they may require an explicit cohort, checked join cardinality and independent validation. Repository work can require the applicable team policy and its executed checks. These establish observable compliance, not the model's internal understanding.

Track delivery as observed, unavailable or missing; checkpoints as pending, passed, failed or unobservable; and the task outcome separately. A successful task with an unobservable checkpoint does not manufacture procedure-use evidence. A mandatory checkpoint gates only the operation and boundary covered by its policy. Bind receipts to current inputs and restore pending checkpoints after compaction or restart.

### Unified operator status

Extend the existing status surface with one bounded view: task and environment, coverage boundary, selected revisions and combinations, applicability reasons, delivery observations, completed and pending checkpoints, evidence gaps, running jobs, remaining budget, and any proposed promotion. Include the exact permitted next action and whether existing delegation authorizes it.

A typical status is: required procedure loaded; target environment verified; two checkpoints passed; interaction verification pending; candidate revision not yet evaluated. Show why a procedure was excluded or could not be restored. Refresh on meaningful state changes and explicit inspection, rather than injecting the complete catalog or emitting unchanged messages. Delegated approval and loading do not require a new human prompt for each already-authorized action.

## Measured evaluation contract

### Freeze an evaluation plan

Before candidate execution, persist an immutable EvaluationPlan with:

- Incumbent and candidate instruction closures and the exact candidate revision.
- Change objective and declared applicability scope.
- Separate development, protected regression, held-out target and incompatible or unknown-environment cases.
- Fixture revisions, initial repository/data snapshots, reset recipe and fixture lineage.
- Verifier identities, exact validation code or commands, and required evidence.
- Model and host configuration, available capabilities, tool permissions and runtime identity.
- Case ordering, repetition policy, declared minimum coverage and decision thresholds.
- Model-call, attempt, output, wall-time and disk budgets; deciding cost limits only where enforceable.
- Evaluation-policy revision and leakage exclusions.

Use independent fixtures initialized from the same baseline for each arm. Do not run the candidate on a workspace already modified by the incumbent. Record ordering and use a predeclared balanced order for stochastic trials. Shared seeds are useful where supported but do not imply deterministic LLM output.

The candidate author must not tune against held-out results. Keep expected answers and authoritative verifier files outside its declared write scope. If the deployment cannot protect that separation, report the resulting evaluation limitation and do not label it a blind trial.

### Execute and verify

Add a bounded local replay runner around existing execution and experience facilities. The runner creates isolated fixture workspaces, records admissions before dispatch, captures terminal outcomes, and restores or verifies the fixture between arms. It does not create a second DAG scheduler.

The first acceptance corpus uses synthetic local repositories, APIs or fixtures and disposable data. No production credentials, live database migrations, network discovery or remote activation are necessary.

Deterministic fixtures establish routing and promotion mechanics. They do not demonstrate improved model behavior. Model effectiveness requires a separately authorized local OpenCode evaluation using actual calls and the same declared verification rules.

Verification should come from executed tests, artifact checks, state comparisons, contract checks or other versioned validators. A worker's self-report is not sufficient. Model reviewers may supply additional assessment, but reviewer scores alone cannot satisfy a mandatory behavioral gate.

If required host/tool restrictions are unsupported, refuse that evaluation profile. Do not substitute allowBuiltinToolMap or a broader tool allowance for a required denial guarantee. Proposal generation, replay execution and private skill-auditor calls have separate capability requirements.

### Compare outcomes

Measure target improvement, losses among incumbent successes, correctness, constraint violations, abstention or unknown outcomes, and cost separately. A candidate that gains five tasks and loses two protected successes has two regressions; net gain does not erase them.

Repeat trials within a task family are clustered evidence, not additional independent task families. Extend the evaluator with an explicit versioned request when repetitions or larger suites are needed; preserve legacy records and semantics. Do not evade the old thirty-pair bound by presenting arbitrary shards as independent successful evaluations.

| Verdict | Conditions |
| --- | --- |
| eligible | Valid complete evidence; declared minimum coverage met; target objective met; protected and mandatory gates pass; deciding budgets pass |
| rejected | Valid evidence demonstrates a mandatory regression, forbidden effect, or failure of the declared completed-benchmark objective |
| inconclusive | Required trials, observations, coverage or deciding cost evidence are missing or insufficient |
| invalid | Identity, fixture, verifier, lineage or integrity checks fail, including training/evaluation leakage |

Protected deterministic behavior and permission/integrity invariants retain hard gates. Stochastic task performance uses a declared comparison calibrated to incumbent variability, with its margin, minimum independent cases, uncertainty method and stopping rule fixed before execution. Small suites qualify only their finite benchmark scope. Never publish a universal success-rate claim from an eligible receipt.

Missing cost is unknown, not zero. If cost is a deciding criterion, unknown cost prevents eligibility. If it is descriptive, the receipt may qualify on the other criteria but must leave cost unmeasured. A cost-only optimization can qualify under a predeclared non-regression objective; do not force a fabricated correctness improvement.

### Candidate-driven evaluation profile

Build the initial case inventory from observed skill reminders, repeated searches, failed gates and other reviewed workflow incidents. Capture bounded feedback and existing evidence references with consent and deployment privacy rules. A late skill mention is a routing-error candidate, not proof the skill should always apply. Historical logs still need reproducible inputs, expected outcomes, permission review, verifier ownership and leakage checks before becoming evaluation cases.

Remove the universal eight-family, two-repeat, 32-to-48-execution starting requirement. Use a staged profile: cheap schema and deterministic checks; targeted replay of the candidate's motivating cases and retained old successes; then budgeted paired behavioral evaluation only when the result would inform a real promotion. Required coverage follows the changed behavior, selected skill combinations and deployment scope. Freeze the plan and finite budget before each stage.

Measure incumbent variability before deciding how to compare stochastic outcomes. Hard permission, integrity and deterministic correctness violations remain hard failures. For variable task success, use predeclared paired comparisons, tolerances, independent case coverage and an uncertainty/stopping rule appropriate to the objective. An isolated candidate miss beside an incumbent success is adverse evidence, not automatically proof of a population regression. Insufficient power or unstable verifier behavior is inconclusive; do not enlarge the trial after seeing results without an explicit amended plan and preserved history.

Keep gains and losses separate. An aggregate improvement cannot hide a substantiated protected regression. An optional no-skill arm can establish whether the skill helps at all, while preserving mandatory procedures and permissions. Actual call cost is measured, not inferred from task counts. None of this authorizes model spend or loosens the existing publication boundary.

## Evaluation records and resumption

Reuse immutable experience objects for case observations and outcomes, with new typed plan, trial and summary variants where necessary. The new EvaluationReceipt references the exact plan, all required terminal trials, verifier evidence, metric summary and verdict. Store large logs as bounded referenced artifacts.

Every receipt declares its evidence class: simulated mechanism test, actual behavioral execution on synthetic fixtures, or imported observed execution. Simulated outputs can authorize only test-scoped publication to disposable targets. Real managed-skill promotion requiring behavioral evidence must use actual execution-backed results; synthetic data is acceptable, fabricated worker behavior is not. Imported observations must resolve the same exact trial, fixture, verifier and configuration provenance and satisfy the policy's comparison requirements. A static linter result cannot be relabeled behavioral improvement.

Each trial identifies plan, case, repetition, arm and attempt. Preserve failed and interrupted attempts. Commit through the existing locks and revision checks. The summary advances only after its referenced records are durably readable.

On restart, reuse completed compatible trials after checking their inputs and verifiers. A child with unknown execution or effects requires reconciliation, not an automatic rerun. Reuse the execution contract's capability and stop/effect semantics. Where safe reconciliation is unavailable, mark the evaluation inconclusive and retain its evidence.

All proposal, worker, repair, checker and replay cost belongs to the original evaluation budget lineage. A retry, restart, alternative candidate or new graph proposal cannot silently reset that lineage. Record provider-internal retries only when observable and retain unknown usage.

Candidate changes, prerequisite drift, fixture or verifier changes, material environment/configuration changes, receipt revocation and evaluation-policy changes invalidate eligibility for a new promotion decision. Represent withdrawal as an append-only supersession or revocation record and check the current authoritative head at publication. Historical receipts remain readable with their original scope; they are not rewritten as current passes.

## Measured promotion and delegated approval

Introduce an opt-in measured-promotion policy for explicitly named managed skill scopes. It specifies allowed source and destination identities, accepted evaluation profiles, required case families and gates, freshness conditions, and who or which existing application workflow may request publication. It is operator configuration loaded at startup; no skill or model tool can broaden it.

The common promoteSkillCandidate path must require, for covered targets:

1. The existing validated candidate and checker approval.
2. A current eligible EvaluationReceipt of an accepted evidence class covering the exact candidate closure, incumbent basis and required policy scope.
3. Unchanged candidate, prerequisite, target and policy revisions.
4. Existing publication authorization and explicit confirmation semantics.
5. The existing transactional backup, publication and recovery checks.

Perform the checks inside the shared publication boundary, including CLI and tool entry points. A legacy route cannot bypass a configured measurement requirement. Recheck mutable heads and target bytes under the existing lock before the file operation. Bind the publication journal to the evaluation and policy digests so crash recovery cannot commit an unrelated candidate.

The existing approve/load policy grants no publication permission. Measurement grants no publication permission either. Where publication has been explicitly delegated, the harness can complete the authorized action without a new human prompt per revision; otherwise retain the existing explicit authorization boundary. Do not replace that boundary with a model's assertion that a candidate is safe.

Publication, activation and delivery remain separate. Publishing a new version does not repin running sessions. The harness must approve and explicitly repin the new closure within load policy before activation. Approval of a source never upgrades a historical unmeasured candidate to measured status.

Keep rollback transactional and explicit. Distinguish an operator-authorized exact restore of the previous revision from publishing a new revision; the former may use its original rollback authority, while recording the withdrawal reason and evidence. Rollback does not erase the failed candidate's evaluation or revoke every delegated child automatically.

Without measured-promotion policy, preserve existing publication behavior and label it unmeasured. Same-user unrestricted filesystem writes remain outside this application boundary; importing external edits through load approval does not retroactively claim measured publication.

### Outcome feedback after promotion

Link subsequent verified outcomes to the activated skill closure, selected combination, environment, operation and checkpoint evidence. Classify extraction, transport, gate configuration, source-data quality, procedure compliance and substantive task failures separately. A failed task does not establish that the skill caused the failure.

Use bounded deterministic triggers for reevaluation proposals, such as a verified protected-case regression or repeated equivalent failures under the same scoped revision. Policy declares the trigger and deduplication window. A proposal references evidence and a fixed evaluation objective; it neither edits the skill nor launches an unlimited learning loop. Domain procedures, reusable query helpers and graph patterns have distinct candidate identities.

Withdrawal, quarantine from future selection, rollback and active-run handling require explicit policy transitions. Quarantine preserves history and identifies affected bindings; it does not silently rewrite current sessions or assume delegated children have stopped. Mandatory violations block affected covered operations immediately under existing policy, while other suspected regressions await review. This feedback path uses existing receipts and status surfaces without an always-running model.

## Artifact building reference skill

Retain web-artifacts-builder and its separately approved frontend-design companion as an optional later V1 extension, as explicitly requested. It is not the first operation registry, evaluation example or dependency of Phase One. The [artifact skill extension](alg-v1-artifact-skill-extension.md) preserves its source, portability, helper, offline and verification requirements.

Qualify that pack when an actual artifact workflow needs it. Its evaluation must serve that workflow; general applicability and investigation work do not wait for Bash, frontend dependencies or browser qualification.

## Graph authoring path

Begin graph improvement by choosing and parameterizing existing validated templates, retaining their verifiers and recording outcomes by task family and exact template revision. Free-form graph authoring is a later stage using alg_plan.graph_json; it needs no model-specific planner or executable graph language.

The orchestrator builds a GraphProposal from the user objective, fixed acceptance criteria, scoped repository/environment facts, applicability results, usable skills, capability coverage and remaining budget. It may select an existing template, specialize one, or author a small custom DAG. Choosing one worker or direct work can be correct for a small task.

A proposal records why each node is needed, its input/output references, affected resources, intended effects, required skills, verification coverage and work estimate. Keep that planning metadata in a versioned proposal envelope or additive schema; do not feed unknown fields to the current strict GraphDef parser.

Compilation validates current structural rules plus unresolved prerequisites, coverage of acceptance criteria, exact skill bindings, execution-directory/shell preflight and declared write conflicts. Mapping a criterion to a checker verifies coverage structure, not semantic adequacy. Semantic review is supplementary and separately budgeted.

For the first graph-authoring release, parallelize read-only work and writes that have established independent workspaces. Serialize shared writable resources by default. A model-declared disjoint file list is not an isolation guarantee. Cross-repository migrations require an explicit supported resource/operation adapter; an arbitrary path outside the project cannot be admitted by a generic graph.

The accepted graph and planning references are frozen for that run. Missing information can produce a bounded discovery node. It cannot license an unbounded research loop or broaden permissions.

The knowledge graph supplies facts and procedures; the execution DAG supplies dependencies and work state. They remain separate stores with exact references between them.

The investigation companion adds a hypothesis and evidence view: an inferred table relationship, a suspected physical cause and a scheduled worker are different objects. Its first pilot uses an authored fixed graph on the existing executor. Specialist coordinators can propose bounded follow-up subgraphs in later graph-authoring work, but all accepted nodes share the root executor, resource admission and cumulative budget. There is no independent recursive scheduler per coordinator.

## Improving graphs and bounded revision

Represent reusable graph patterns as versioned declarative artifacts. Candidate generation can suggest removing a redundant researcher, adding a verification step, changing decomposition, or selecting a different skill. Patterns have applicability declarations, evaluation scope and provenance just like procedures.

Compare incumbent and candidate patterns on the same fixed tasks, repository states, criteria and budgets. Hold model/host configuration constant when measuring the topology effect. Evaluate any model-allocation change as a separate declared treatment. Count planning, extra workers, retries, checking and failed runs in total cost.

Record verified task success, protected regressions, stranded or retained work, elapsed time, context bytes and measured cost. Fewer agents is a legitimate improvement. Historical correlations nominate proposals; they do not establish that another worker caused success.

Promotion changes which pattern is eligible for future plans. It does not rewrite active runs.

Automatic revisions of a running graph are a final, separate V1 increment. They require the execution contract's safe reconciliation and replacement capabilities. Revisions preserve objective, criteria, permission scope, attempt history and cumulative budgets, with at most one accepted automatic replan per unchanged stall signature as already specified. Retain completed nodes only when their inputs, outputs, code/fixture state, skills and verifiers remain compatible. Unknown effects block affected replacement. Unrelated valid branches remain available.

If that lifecycle support is incomplete, expose a revision proposal and a visible blocker. Do not imitate safe continuation by starting a fresh run with a fresh budget.

## Storage context and performance

Use the existing session-memory, skill-evolution and experience stores. Add immutable record variants and references; do not add an independent knowledge database. Derived indexes and caches are disposable and scoped by revisions, caller visibility, task and environment. No distributed transaction is assumed between stores.

Publish immutable objects before updating authoritative heads. Reference validation and reconciliation handle incomplete cross-store publication. Preserve previous committed state on failure. Store exhaustion reports an explicit gap and cannot silently evict protected evidence.

Reuse current discovery bounds, eight-prerequisite closure limit, two-hop memory traversal and context allocator in the first increment. A bound reached before mandatory coverage is established returns coverage_unknown or needs_context. Per-request applicability summaries are bounded references; full evaluation histories remain on disk.

Evaluation policy must set finite case, repetition, model-call, attempt, time and disk limits before execution. Missing budget fields do not mean unlimited work. Default unattended model execution is disabled. Use current provider capabilities only; if a required ceiling cannot be enforced, reject that unattended profile.

Measure incremental warm/cold routing latency, catalog reads, receipt writes, context bytes and disk growth before setting an acceptance threshold against the baseline. Do not attribute existing context-delivery benchmark numbers to the new matcher or replay runner. Rust extraction, embedding search and background model ranking require demonstrated need and are outside this increment.

## Implementation boundaries

This table spans the full capability design; the Phase One plan selects its initial subset. Replay, promotion, artifact adapters and graph revision are later additions.

| Module or existing surface | Change |
| --- | --- |
| session-memory schemas and skill-index | Versioned manifest parsing, exact closure identity, scope checks and explainable applicability inputs |
| New focused skill-routing module | Pure bounded matching and aggregate result; no filesystem, host SDK or model imports |
| Context runtime and preflight | Trigger checks at covered boundaries, restore selections, preserve owned context and expose gaps |
| Existing capability asset inventory and optional artifact adapter | Pin helper/build assets and implement local artifact preparation, bundling and preview checks for the web-artifacts-builder pack |
| skill-evaluation and experience schemas | Versioned plans, trial provenance, protected metrics, verdicts and receipt resolution |
| New focused replay runner | Isolated fixture lifecycle, budget reservations, execution adapter calls and durable resumption |
| skill-evolution-store and publication entry points | Common measured-promotion guard and evaluation-bound transaction journal |
| Existing status, memory CLI and alg_skill | Preview applicability, measurement references and exact reasons; retain separate approval/load actions |
| Later graph proposal module and alg_plan | Declarative proposal validation and projection into the existing GraphDef |
| Later execution lifecycle work | Only the approved plan-revision transitions from the existing recovery contract |

Use dependency injection for clock, scoped resolver, verifier and execution adapter. Avoid generic rule engines, a second matcher, a new lock implementation, and a tool for every record. Begin evaluation through the existing CLI surface; expose an additional model-facing operation only if the workflow requires it and permission checks are covered.

Model/provider identifiers are recorded as experimental conditions, not branches in the core algorithm. Run the same matcher, schema validation, promotion rules and graph compiler for every model.

## Compatibility and migration

New routing and measured promotion default off. Observe mode records bounded diagnostics without changing prompts, bindings or dispatch. Assist mode may recommend and restore approved procedures. Mandatory enforcement requires explicit routing policy and demonstrated coverage at the relevant ALG boundary.

Existing approvals, revocations, immutable receipts and candidate histories remain readable. Old evaluations are not silently accepted by the measured-promotion gate; an explicit compatibility assessment or new evaluation must establish the required closure and case coverage. Old schema output is retained unchanged.

Existing graph templates remain supported. No current execution graph is rewritten on upgrade. Policy changes require the existing restart workflow, and matched rule changes invalidate dependent decisions without invalidating unrelated rules.

The first implementation reconciles the umbrella and four component documents with these concrete choices. The canonical owner contracts retain authority. This draft does not silently replace their published content or change runtime behavior.

## Phased V1 delivery

The [design index](alg-v1-design-index.md) owns sequencing; the detailed [Phase One plan](alg-v1-phase-one-investigation-plan.md) owns its implementation gates.

| Stage | Deliverable | Exit condition |
| --- | --- | --- |
| Phase 1a Readiness and qualification | One reviewed workspace requirements registry; baseline visibility; real MCP capability and deployment data/model profile | Existing approved skills are selected from real workflow requirements; unsupported action coverage is explicit; a bounded deployment probe qualifies the route where access is available |
| Phase 1b Durable investigation | Fixed template on the existing graph executor plus managed admissions, result reuse, job reconciliation and context restoration | Completed searches and unresolved submissions are not automatically repeated; state and skills survive compaction/restart |
| Later Measured promotion | Candidate-driven replay and common publication guard | Useful candidate and curated cases exist; evidence meets a predeclared scoped comparison |
| Later Template improvement | Choose and parameterize existing templates; measure outcomes by task and template revision | Better verified outcomes or cost without protected regressions |
| Later Graph authoring and revision | Evaluated authored patterns, followed by lifecycle-safe run revisions | Existing graph/recovery contracts and cumulative budgets remain enforced |

The former A–E labels describe capability families, not competing first projects. A is delivered incrementally through Phase 1a/1b; B follows qualified cases and candidates; C/D begin with template selection and measured specialization; E remains last. The older umbrella's baseline/visibility and recovery/task-sizing work maps into Phase 1a/1b rather than defining a parallel roadmap. The four owner contracts retain their responsibilities.

The artifact pack is optional later work. The investigation profile uses existing datalake-mcp analytics, and its service-specific ledger depth follows actual job guarantees. A missing remote environment does not block local readiness and deterministic recovery fixtures, but it leaves deployment acceptance open. No V2 implementation or probes occur.

## Local acceptance and failure tests

| Area | Required cases |
| --- | --- |
| Applicability | Closest lexical match incompatible; no candidate; unknown resource; duplicate names; stale environment; revoked closure; conflicting requirements; incompatible optional skill with unrelated work allowed |
| Authority | Untrusted manifest declares itself required; inferred edge requests mandatory status; load approval attempts to authorize publication; model alters policy scope |
| Timing and recovery | Required skill appears after initial plan; fresh planning step required; twenty synthetic compactions; missed hook; restart without cache; plain continue; exact prerequisite restoration |
| Context | Full closure or explicit needs_context; no instruction duplication; foreign contributions preserved; unavailable host confirmation remains unavailable |
| Evaluation integrity | Candidate or fixture drift; verifier edits; undeclared training leakage; repeated source summaries; duplicated case IDs; missing/unknown outcomes; zero mistaken for missing cost |
| Protected performance | New gains alongside lost old successes; incompatible environment; no safe applicable skill; cost-only improvement under a declared objective; insufficient sample coverage |
| Publication | Legacy entry point under measured policy; revoked evaluation; concurrent source edits; crash before and after file publication; idempotent recovery; explicit rollback; no automatic repinning |
| Execution | Timeout with live child; unknown effects; exhausted budget; retained completed trials; no blind replay or cost reset |
| Graph stages | Missing verification coverage; cycles; unsupported resources; shared-write conflicts; unnecessary fan-out; changed inputs invalidate only affected work; failed criteria cannot be removed |
| Optional artifact skill | Complex versus simple task routing; companion selection; pinned scripts and component archive; Windows shell/path preflight; offline dependencies; bundle loading, interaction, navigation, accessibility and declared visual checks |
| Procedure use and combinations | Instructions delivered but checkpoint omitted; fabricated receipt; stale checkpoint after restart; conflicting required skills; optional exclusion; combined context overflow |
| Post-promotion feedback | Transport failure misattributed to skill; repeated incident deduplication; reevaluation proposal without execution; scoped quarantine; active child requiring reconciliation |
| Investigation profile | Partial map coverage; inferred versus checked join; authorized map enrichment and conflict; duplicate expensive query; job recovery; temporal leakage; shared lineage; misleading metrology signal; insufficient evidence |

Acceptance runs locally on Windows/PowerShell and Linux/Bash for the same candidate revision. The [Linux/Bash acceptance plan](alg-v1-linux-bash-acceptance-plan.md) specifies the dedicated WSL environment, single-command deployment through the existing manager, shell/path/process cases and package qualification; native-target evidence remains separate. Use synthetic fixtures for deterministic mechanisms, including air-gapped reproducibility. The complete simulated candidate-to-publication acceptance path uses disposable test targets and cannot issue production-eligible behavioral receipts. Package extraction and supported V1 host hooks receive local acceptance checks. No GitHub runner tests are introduced.

For applicability and, when implemented, measured promotion, acceptance requires zero unauthorized approvals/publications, zero stale-receipt dispatches on covered operations, zero clipped required procedures, and all labeled mandatory exact matches delivered before plan commitment. Every injected missing-evidence case must remain visibly unknown, inconclusive or invalid as specified.

A separately authorized live evaluation is required before claiming improved model task success. Record the exact runtime/package, fixture, model configuration, completed trials and failures. Do not infer cross-model performance from provider-independent code or from passing synthetic tests.

## Worked example

A partner asks ALG to update an API and its frontend against a shared database. A familiar migration skill ranks highly, but its manifest applies to a different database version.

Applicability marks that skill incompatible and identifies a missing fact about the target environment. The harness obtains that fact through an existing permitted source, selects the compatible approved procedure, and loads it before committing the plan. A lack of approved access remains a blocker for the affected operation.

A candidate procedure later improves migration validation. Its evaluation includes the original working cases, the new case it claims to solve, and a deliberately incompatible environment where correct behavior is to stop or seek information. A candidate that succeeds in the new case but breaks a protected old case is rejected.

Once measured eligibility and publication authorization both hold, ALG publishes the exact revision through the existing transaction. Existing sessions retain their pins until explicitly repinned. A later graph-authoring increment may reuse the improved procedure to propose a migration-check step followed by compatible API/frontend work and integration verification. It cannot infer authority to perform a production migration.

## Review decisions

This draft chooses one workspace requirements registry plus the existing per-skill ALG.json surface, exact predicates before learned scoring, separate mandatory-routing authority, and durable managed investigations first. Candidate-driven measured promotion and template improvement follow; graph authoring precedes autonomous graph mutation.

Before implementing each stage, settle its exact manifest/request schema versions and CLI names, instantiate its selected fixtures with pinned verifiers, qualify its operation adapters, and supply applicable deployment budgets. Later replay and promotion schemas are not prerequisites for Phase One. The investigation profile additionally needs the actual datalake-mcp tool schemas and observed permission, job and map-update guarantees. Its backend capabilities are not inferred from the FastMCP framework name. These choices must be concrete in implementation tests; they do not require V2 design work.

The first release claim should be narrow: ALG can identify workspace requirements, restore approved procedures, and resume covered investigations without automatically repeating compatible completed or unresolved remote work. Enforcing measured publication eligibility is a later release claim. Broader claims about autonomous learning, general correctness, safe arbitrary tools or optimal graph construction remain unestablished.

## Source contracts

All references below are pinned to the design baseline.

- [Durable operational context and execution](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/skill-knowledge-graph-design.md)
- [Context and decisions contract](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/context-decision-contract.md)
- [Knowledge and environment contract](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/knowledge-environment-contract.md)
- [Execution and recovery contract](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/execution-recovery-contract.md)
- [Coordination and improvement contract](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/coordination-improvement-contract.md)
- [Session memory and delegated skill approval](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/session-memory.md)
- [Existing paired evaluator](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/skill-evaluation.ts)
- [Skill publication transaction](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/skill-evolution-store.ts)
- [Planning surface](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/src/tools.ts)
- [Optional learning and replay limitations](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/implementation-status.md)
