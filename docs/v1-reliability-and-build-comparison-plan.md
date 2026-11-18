# V1 development and rigorous comparison with native Build

Status: capability-first development and evaluation plan, 12 November 2026, following the request to make ALG demonstrably better on difficult work without false positives. The historical planning baseline was PR #14 at `1f06455`, with 0.5.6 product repairs at `01e18ec`; the earlier hosted comparison used 0.5.5 runtime `373b8d0`. Current implementation and later receipts are identified below. This document does not activate planned runtime contracts or launch model cohorts. V1 only; local Windows/PowerShell and native Ubuntu/Bash tests; no GitHub runners, Gemma, global configuration edits or merge.

Implementation has begun prospectively: 0.5.7 runtime `79da198` implements task admission; 0.5.8 runtime `871868c` adds current-user source capture, with full local checks and deterministic host recovery evidence on both platforms. H0 adds retained issued denominators, completed-summary checks, resource coverage, hard development fixtures and compaction measurement. The [implementation status](v1-implementation-status.md) distinguishes delivered mechanisms from remaining verification coverage, shared allowance, qualified service/oracle isolation and behavioral evidence. The capability-first amendment below changes the priority for future design and cohorts; it does not change historical inputs, limits, grades or outcomes.

The sections below define the first product changes; the added **Development work packages**, **Hard benchmark specification**, and **Evidence and improvement rules** make their delivery and evaluation concrete. The earlier twenty-trial confirmation proposal is superseded by a qualification rehearsal and a separately powered, frozen confirmation. Small cohorts can find defects; they cannot promise a reliable superiority conclusion.

## Decision and evidence

The [13 November augmentation plan](v1-capability-augmentation-plan.md) defines
the next implementation increments against 0.5.12: explicit verification
authority, cause-specific repair, live obligation recovery, qualified domain
workflows and selective graph improvement. It refines the sequence below while
preserving the capability-first objective and all historical evaluation rules.

ALG should earn its overhead on tasks requiring durable recovery, bounded expensive work and independently checked evidence. It need not replace native Build for a small known edit. A benchmark designed to force Build to fail would not tell us which tool to use. Preserve easy controls, native Build delegation/checkpointing, all failures and identical external rules.

### Capability-first objective — user priority clarification

The primary objective is **reliably solving difficult problems with adequate evidence**. Lower token usage, fewer agents and faster completion are secondary benefits, not requirements for a useful capability gain. A more expensive graph can be preferable when it produces a verified solution that the cheaper approach cannot produce. Faster unsupported answers do not outrank slower correct ones, and more calls or a persuasive report do not establish quality.

Evaluate in this order:

| Priority | Measure | Decision meaning |
| --- | --- | --- |
| 1. Correct, supported completion | All critical deliverables, independent correctness, adequate source/causal evidence and required constraints | Primary capability outcome; a correctly unresolved conclusion passes only when the task's evidence warrants it |
| 2. Reliability over difficulty and duration | Fresh variants, source changes, compaction/reassignment, retained valid work and calibrated handling of ambiguity | Establishes where the capability persists rather than succeeding once |
| 3. Useful effort | Verified progress, discriminating probes, recovery, avoidance of mechanical loops and repeated accepted work | Diagnoses how to improve the design; activity and self-reported confidence are not progress |
| 4. Efficiency at comparable quality | Time to verified solution, service work, model usage and billing coverage | Describes the price of capability; a separate efficiency claim needs its own evidence |

Retain the old short-budget controls as regression and overhead diagnostics. They do not define the maximum effort appropriate for a hard factory investigation. Future primary hard-task cohorts use a prospectively chosen, generous but finite operating envelope grounded in reference feasibility, discovery work, service latency and the intended user workflow. Offer the same headroom to both arms; equal allowance does not require equal actual consumption. The old eight-minute/40-turn/200k limits remain unchanged for their historical/control track.

Use two views of each future hard-task study: **capability at the declared practical ceiling** is primary; **quality versus resource use** is secondary. If a resource ladder is needed, freeze its tiers, task variants, issuance order and analysis before the batch, and offer each tier to both arms. Each issued trial remains visible, including unsuccessful lower tiers. Specify fresh starts versus continuations symmetrically; a continuation retains prior costs, failures and task identity. Do not choose the winning tier or grant only ALG a longer run after inspecting outcomes. A richer graph solving more cases at greater cost can support a scoped capability claim without supporting an efficiency claim.

Distinguish wrong answers, unsupported conclusions, mechanical failures, unavailable required evidence and resource-stopped unresolved work. A cutoff remains an unsuccessful issued trial at that operating point; it does not prove that the method could never solve the task. Do not discard stopped trials, label them correct, or treat budget-dependent stops as statistically non-informative censoring without justification. Report time/cost among solved tasks alongside all-issued completion and total spend, so survivor-only averages cannot hide failures.

For production design, separate a planning estimate/soft resource target from explicit operator hard limits. Within an admitted hard envelope, continued work can be worthwhile when it collects a missing required observation, tests a distinct hypothesis, completes a necessary validation or recovers durable progress. If a soft target is missed, expose the remaining evidence obligations and next action; do not turn useful work into failure solely to optimize a token target. Existing hard limits remain authoritative, and this design does not add a runtime extension mechanism. Any future operator-authorized extension must preserve task identity, history and cumulative accounting; frozen benchmark trials receive no mid-trial extensions.

The immediate design repair remains evidence coverage before edits. More runtime cannot recreate an unrecorded before-work baseline. Reuse the task contract, preservation snapshots, native command receipts and investigation ledger to map each critical criterion to its required observation, collection time and coverage. Capture required prior state before admitting writes; after work, distinguish missing collection, insufficient coverage, stale evidence, a real defect and a checker interpretation error. Route a missing post-work observation to a bounded probe, a real defect to the affected producer, and an unavailable original baseline to an honest blocker unless an independently recorded prior state can supply it. Do not rerun already-correct implementation merely to manufacture proof.

Iterate on fresh development cases until the design improves verified capability, then freeze the candidate for independent confirmation. Negative results are design evidence. Repeated development is welcome; repeatedly testing confirmation data until one candidate wins is not. The confirmation controls below still apply, and no universal superiority guarantee is made.

The post-repair Terra cohort has eight ALG trials: three whole-task passes and five cumulative-usage stops. All four ALG coding artifacts are correct; no ALG report arm produces a final report. Windows default report and Linux targeted report choose research graphs incapable of writing the requested root-level preparation file. Linux default report recovers preparation after actual compaction/restart, then exhausts the shared cap during continuation. These are distinct outcomes, not a general context-loss or parser-failure diagnosis.

Coding workflows use about 5.4–6.0 times Build's reported usage components in these runs. Cache reads are included; this is not billed-cost evidence. Single-repeat, free-choice plans and uncontrolled host load prevent a causal platform or checker-strategy ranking. The previous Windows ALG completion counts are unchanged. [Exact results](v1-benchmark-failure-analysis.md#post-repair-validation--windows-and-linux).

| Finding | Evidence / implementation boundary | Priority |
| --- | --- | --- |
| Graph structure is validated, deliverable feasibility is not | `alg_plan` validates graph/schema/shell paths but has no required work-kind/destination contract. `researcher.md` denies shell and permits writes only inside run artifacts. Two live attempts demonstrate the mismatch | P0 |
| Optional evidence requests are omitted | None of the four coding plans supplies a shell gate or preservation request. Native command receipts are useful, but cannot invent missing before-work hashes | P0 for explicitly required verification/preservation |
| Prompt wording conflicts with criterion authority | Orchestrator guidance keeps researcher proposals advisory, while the coding template describes research as “hard acceptance criteria” and wires `acceptance_criteria` alongside original criteria | P1; tighten provenance, not schema leniency |
| Attempt caps are not a task-wide model usage budget | Graph revisions preserve attempts; the investigation ledger preserves remote work costs. General multi-phase model usage is currently bounded by the external benchmark, not an equivalent shared production ledger | P1 |
| Whole-task size is chosen too late | Linux continuation selected `coding-compact` after most of the budget was spent on a full preparation diamond | P1 |
| New helper/recovery mechanisms are not exercised by this live cohort | Coding plans omit shell gates. Windows helper and gate-only recovery evidence comes from local regressions | Keep claims scoped; deterministic acceptance first |

The follow-up mechanical review reproduced two further defects: recovery/checker lookups searched only the visible four-attempt tail and lost an archived original receipt by attempt six; immediate SDK rejection during evidence-collection abort could classify a timeout/cancellation as an SDK fault. Focused patches and regressions address both. A third reproducer demonstrates a 1,123,980-byte attempt archive from valid bounded execution receipts against a 524,288-byte archive limit. The 0.5.6 repair uses compact version-3 rows backed by verified detail sidecars, leaving existing byte caps unchanged; 100-attempt fixtures produce archives of 90,562 and 91,042 bytes. Older versions 1/2 remain readable; new compact archives need the new reader. Gate-recovery metadata remains inline because it is only three fixed digests, not a file-list payload. These are local reproductions, not newly established causes of the twelve earlier Terra outcomes. Exact final scope and receipts belong in the accompanying implementation-status update.

## Architecture constraints

Reuse `alg_plan`, `validateGraph`, `graph-policy.ts`, existing run/attempt persistence, checker evidence, session-memory projections and the investigation ledger. Reuse datalake-mcp recipe/job/lookup/validation/read primitives; keep bulk tables and Arrow/Parquet results outside context. Extend existing records rather than add another graph engine, vector database, scheduler, permission system or store format.

Model proposals are untrusted inputs. A capability declaration cannot grant tools, certify semantic truth, approve a skill or replenish budget. Host permissions remain authoritative. Evidence identity, source freshness, adequate coverage and scientific validity are separate checks.

Existing runs remain readable without invented contracts/receipts. New durable fields must use the existing version/reader compatibility rules. Missing old evidence is unavailable, never silently successful. Managed investigation graphs remain fixed; this plan adds no recursive orchestrators or completed-node rewriting.

## First V1 increment: admit feasible work with verifiable completion

### 1. Admit a task contract

Extend the existing planning surface with a small typed contract for new work:

- Work kind: investigation/read-only findings, project-file change, or a bounded mixed workflow.
- Deliverables: destination (response, run artifact or contained project path), required producer capability, and any structured output contract reference.
- Original requirements and source: preserve the accepted original criteria and their digest; label researcher recommendations separately.
- Required verification and explicit protected paths. If the task requires proof that tests ran or files stayed unchanged, the plan must nominate a host-evidenced mechanism or return a concrete unmet prerequisite.
- Explicit phase boundary and completion condition, including a deliberate preparation-only stop.

This must be an admission requirement for new qualified plans, not another silently optional hint. The implementation must define migration for existing tool callers and preserve old persisted runs as legacy/unqualified; it cannot claim to have validated a contract that was never supplied. Revision calls keep the accepted contract immutable. Natural-language requirement extraction can still be wrong: validation proves compatibility with the declared contract, not perfect understanding of the original request. Retain the original request/reference for review and use a separate external oracle in comparisons.

Check producer capabilities using trusted shipped role policy and available effective host-agent configuration. Do not accept model-written “I can write files” claims, use model-name branches, or build a second permission interpreter. A known read-only role cannot satisfy a project-write deliverable. A host override that prevents a required operation yields a bounded blocker; unknown effective permissions must be labelled unknown, not certified. No permission widening.

Fail admission before creating executable work or reserving attempts. Return fixed diagnostics identifying the incompatible requirement and eligible role/template category, without injecting untrusted key names or raw child output. Do not silently replace an explicitly selected graph or execute a different task.

File targets: `src/tools.ts`, `schemas.ts`, `types.ts`, `graph-policy.ts`, existing run persistence, `agents/orchestrator.md`. A small shared contract module is appropriate; a new store is not.

Normal and compaction context should carry a bounded active-task pointer: contract/graph digest, current phase, completed evidence references, remaining allowance and the next permitted action or blocker. Retrieve exact criteria, procedures and evidence through existing status/artifact/skill tools when needed. Context is a projection; neither a prose summary nor model recollection is the authority for replay, scope or approval.

### 2. Make the short route discoverable and correct

Describe templates by capability and required uncertainty:

- Known files + accepted criteria + project changes: compact implement → fresh checker.
- Unresolved discovery: bounded discovery followed by implementation/checking; reuse the admitted discovery result.
- Read-only synthesis: research graph returning a response/run artifact.
- Qualified data investigation: existing fixed managed graph.

Keep task selection separate from permission. Do not infer “needs write” from fragile keywords or change defaults until the qualification cases pass. Specify how callers choose discovery explicitly; omission must not silently imply both zero uncertainty and full capability.

Remove conflicting “hard acceptance criteria” language from research descriptions. Worker prompts distinguish original hard requirements, advisory proposals, required project deliverables and optional internal run artifacts. An internal `artifact_path` constraint must not redirect a requested root-level deliverable.

File targets: `src/templates.ts`, matching `templates/*.json`, `agents/*.md`, worker prompt construction and focused plan/template tests.

### Acceptance for this increment

Before child dispatch, attempt reservation or work side effects, reject research-only graphs assigned `preparation.md` or `report.json` in the project root; accept compatible compact graphs. A root model may already have spent calls proposing the plan; count those calls. Exercise ordinary/custom graphs, explicit read-only responses, internal artifacts, absent/denied host capabilities and legacy runs. Enforce the same rules at admission, relevant revision and resume boundaries without consuming child attempts or resetting budgets.

Required preservation must retain the original before hash across retries; required execution must have a native or shell-gate receipt with honest missing metadata. No silent promotion of model claims. Criteria and deliverables survive compaction/restart byte-identically. Tests run locally on both operating systems; deterministic OpenCode host fixtures must cover the new tool arguments before any paid comparison.

## Second increment: sustain useful work and measure its cost

First add observation, then choose a policy. Attribute calls and reported input/output/reasoning/cache components to root, child role, graph, attempt and phase. Record explicit prompt byte sizes, tool-result bytes, retries, setup time, checker work, and time waiting for remote jobs. Mark provider counts unavailable/overlapping where appropriate. Do not equate summed components with unique tokens or dollars. Review of the exact recorded Windows host found disjoint normalization (cache removed from input and reasoning removed from output), not demonstrated double-counting in the current collector. That host also normalizes missing usage to zero: numeric-field presence is not proof of complete upstream telemetry. Preserve the historical formula and caps.

Keep child inputs bounded and relevant. Avoid duplicating goal/criteria in both instruction text and wired inputs when a single authoritative copy suffices. Pass artifact references and bounded result pages instead of repeated large summaries. Benchmark any prompt/tool-surface reduction with original correctness criteria unchanged; removing verification to save tokens is not an improvement.

Make a plan display its necessary work, unresolved evidence obligations and remaining verification allowance. Reserve enough of the task's finite allowance to check and report. Allocate more admitted effort where it can resolve a consequential uncertainty; do not remove necessary investigation or falsification merely to minimize calls. Planning estimates are not hard limits, and text length does not give exact token forecasting.

A multi-phase task must keep one host-owned task identity, accepted contract and cumulative allowance through continuation. Design this as a compatible extension of the existing root/task records, not a new database or arbitrary nested run tree. New plans, retries, compaction or graph revisions cannot reset the allowance. Reuse the investigation ledger's existing job/cost reservations rather than adding competing remote accounting.

V1 implementation boundary: reserve **child dispatches** through the existing
root checkpoint lock before ALG launches them; a dispatch is not one provider
request, because a child can execute multiple model/tool steps. Root planning
and host compaction also occur outside ALG's dispatch boundary. Attribute those
with deduplicated host observations and explicit missing/late usage, but do not
call a polled cutoff a hard provider-call or invoice cap. A hard global request
cap requires a verified pre-provider host gate covering root, child and summary
requests; the installed V1 hook types alone do not establish that guarantee.
Keep the external comparison cutoff and its overshoot receipts. Until a host
gate is qualified, describe production limits as bounded ALG dispatch plus
observed host usage. This is a V1 constraint, not authorization for V2 work.

The latest controls also prioritize source fidelity before additional graphs:
preserve bounded host user-turn text alongside the planner's declaration, and
establish the required verification scope before edits. Missing field definitions
in a child prompt are delegation loss even when the durable planner summary is
perfectly preserved. A current-turn snapshot does not recover earlier context,
and a late file read cannot manufacture a before-work preservation baseline.

Start with accurately observable call/attempt and elapsed limits. Provider usage is a separately labelled, potentially delayed observation; unavailable billing is never zero. Define crash reconciliation and in-flight overshoot before treating usage as enforceable. A hard dollar ceiling needs an independently enforceable provider/account control, not the current zero-valued cost field.

Acceptance: synthetic multi-phase continuations preserve the allowance, reserve final verification, avoid repeated compatible work and expose the exact reason for stopping. Report quality-versus-resource tradeoffs on the frozen easy controls before changing default graph selection.

## First verification-coverage increment (0.5.9)

Reuse the immutable task contract and transactional run store. New `alg_plan`
admissions require one ordered `evidence_plan` row per original criterion, with
typed references to deliverables, execution, protected paths, change scope or
substantive review. Host validation establishes declaration coverage and valid
references, not that the planner selected the right proof. A review rationale
does not waive a preservation, validation or scientific requirement. The fresh
checker receives the declaration and observations separately and checks adequacy.
New declarations are capped at 16 KiB before admission to keep this additional
context bounded; the before-work record is not copied into child prompts.

At execution admission, before **any ALG child** or attempt reservation, collect
and separately commit a bounded `task_baseline`. Protected paths retain their
original hashes; optional `change_scope` retains a deterministic file census.
Retry and resume reuse that record. A previous attempt with no baseline blocks;
neither a late read nor a model claim can invent the earlier state. This boundary
does not cover root-agent edits made before the run or actions elsewhere.

The optional scope declares existing project-relative directory roots, allowed
changed paths and a maximum change count. It observes regular-file content only:
256 files, 1 MiB/file, 16 MiB total, 4,096 directory entries, depth 32, and a
192 KiB total baseline cap. Explicit exclusions are `.git`, `node_modules` and
`.opencode/runs`; an explicitly excluded root is rejected, never certified as
empty. Symlink entries and nested-root symlink ancestors are rejected. These
checks do not create an atomic filesystem snapshot or prove no transient writes.
Global configuration and external resources need separately qualified evidence;
this increment does not scan them. Effective uniform checker read permission
is required for snapshots and glob for directory census; existing scoped or
unknown decisions block rather than being reinterpreted.

Qualification must respect V1 rule ordering: a final exact capability-wide rule
supersedes earlier scoped defaults. The observed host supplied `*.env` ask rules
before the installed checker's final read-all allowance. Treating every earlier
scoped rule as permanently unresolved falsely rejected that agent. The predicate
recognizes only the final uniform decision; a later scoped or unknown capability
pattern still fails closed. This follows the ordered evaluation in the
[upstream V1 permission implementation](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/permission/service.ts#L237)
and is checked against actual local V1 host responses, without changing config.

Before checking, compare additions, modifications and deletions with the accepted
scope. Task evidence carries baseline/content identities, change count, a bounded
sample and explicit omission count. Post-check changes invalidate the verdict
even when the set of changed paths stays the same. Missing/violated scope blocks
automatic producer reopening: inspection or restoration comes first. Existing
gate-only recovery remains; generic observation-only probe repair, exact relevant
command matching and broader criterion-specific collection are still future work.

Local deterministic tests must cover early discovery changes, missing prior
state, immutable/recovered baselines, scope limits and exclusions, allowed and
prohibited edits, and post-check drift on both Windows and Linux. Real OpenCode
headless checks qualify host wiring and compaction/restart mechanics separately
from model behavior. Keep the earlier paid losses unchanged. This increment
does not qualify the service/oracle apparatus or launch a superiority cohort.

## Mechanical failure qualification

Maintain a deterministic local matrix alongside model trials:

| Boundary | Required behavior |
| --- | --- |
| Shell setup / long Windows paths | Compile or fail before model work; bounded stdout/stderr and identity; no claim a test ran |
| Worker completed, gate setup fails | Persist output and basis; explicit gate-only resume; no repeated implementation or budget refund |
| Crash before/after gate intent/result | Original attempt/receipt lineage retained; uncertain side effects not blindly replayed |
| Child text invalid or incomplete | Bounded reason and safe retry feedback; no invented output or unbounded repair loop |
| Native execution evidence missing/oversized | Correct child identity, bounded total scan/serialization, honest omission; no approval from prose |
| Source/config drift before resume | Validate recorded bases; block stale reuse rather than silently apply old evidence |
| Job accepted but acknowledgement lost | Retain intent/reservation and reconcile by durable identity; never submit another accepted job without justified authority |
| Stale, denied or inconsistent result page | Do not treat old evidence as current; retain uncertainty and previous history |
| Interrupted locks/callbacks | Old callbacks cannot overwrite newer terminal state; release only owned resources |

Use existing fault-injection seams, recovery tests and deterministic local MCP/host fixtures. This establishes mechanisms, not superiority to Build. Preserve any failed test receipts, fix only reproduced defects, and rerun the affected scopes rather than repeatedly launching the whole expensive deployment suite.

Keep failure origin and the useful recovery action visible alongside existing outcomes: local admission/setup, child contract, substantive rejection, remote uncertainty, provider/transport, or external benchmark cancellation. An external usage stop surfacing as an SDK abort must not be counted as a spontaneous provider defect. Derive these labels from host-observed transitions, not an LLM diagnosis.

## Qualify the comparison apparatus before another model cohort

The follow-up methodology review found two oracle defects: an empty preparation file can skip its artifact check, and the coding scorer does not enforce the prompt's two-source-file edit limit. Repair these prospectively with positive and negative fixtures, including valid alternative phrasing. Do not change the original task requirements or retrospectively replace preserved grades. Distinguish an output-shape failure from a missing scientific scope disclaimer in diagnostic fields.

Other apparatus work must precede new paid trials:

- A persisted compaction marker is not proof of a completed summary or successful task recovery. Bind the new compaction request, terminal summary identity/outcome and the independently scored continuation; retain bounded unknown/error states. The prior model cohort's marker-only flag is weaker than deterministic headless evidence.
- Reconcile cutoff, cancellation, quiescence and final usage before host shutdown. A successful message census before shutdown can miss later usage updates. Use a deterministic provider with delayed/missing final usage; mark in-flight requests unaccounted rather than zero.
- Report issued, unissued, completed and stopped trials separately. Comparison eligibility must include source/config integrity and cleanup, not just the task's `passed` field. Preserve artifact outcomes independently from eligibility.
- Allocate matched, isolated service namespaces/job ledgers/caches to each arm. “Same account” means equivalent access, not one arm inheriting another's results. Preserve the within-trial namespace over restart.
- Distinguish native-compaction settings from an imposed compaction milestone. Continuity controls keep and disclose the old harness settings (automatic compaction/pruning disabled); a natural-use track must predeclare the same native settings for both arms rather than silently restrict Build's recovery.

These repairs concern measurement validity; they are not proof that the published losses were scoring or transport mistakes. The reviewed preparation files are nonempty, published cleanup/integrity checks passed, and no failed compaction has been demonstrated. Keep raw results and add qualifications.

## Where ALG could earn an advantage

The strongest candidate is an expensive investigation interrupted after remote acceptance and resumed from durable state. Correctness includes avoiding duplicate work and using valid evidence, not simply emitting the right answer once.

| Workload | Shared challenge | Independent success measure | Hypothesized ALG advantage |
| --- | --- | --- | --- |
| Existing small coding control | Same CommonJS defect and hidden tests | Correct artifact, protected files and completion within budget | None assumed; exposes orchestration tax |
| Existing staged report control | Same skill, JSON contract and compaction/restart | Preparation boundary, valid final report and preserved sources | Retain contract/procedure without excessive machinery |
| Expensive query with lost acknowledgement | Service accepts job, response is lost, host restarts at the service-side milestone | Correct final answer, no duplicate accepted computation/charge as independently defined from service scope and source revision | Existing intent/reservation/lookup ledger |
| Multi-repository contract change | API/schema/client fixtures, one failed validation and already-correct sibling work | Hidden compatibility tests, unchanged protected inputs, bounded repeated work | Explicit dependencies and focused feedback |
| Incomplete factory evidence | Synthetic 11k-entry metadata map, event logs, join-grain error, confounding and a stale source revision | Correct supported/unresolved conclusion, correct denominators/joins, cited current source versions, no unsupported causal claim | Bounded evidence, freshness checks and independent falsification |
| Partial investigation across restart | Two completed branches, one transient service failure, restart before synthesis | Correct synthesis using retained compatible results; no needless repeat of accepted searches | Durable branch results and reconciliation |

Keep data small and local; a large catalog tests navigation, not terabytes of simulated storage. Use an external simulator to count accepted computations/bytes/cost units, with latency as a separate declared scenario. Do not pad delays solely to make ALG look faster. Intentional independent verification, source changes and authorized refresh are not duplicate work.

For scientific cases, create matched negative controls: sufficient evidence for a true effect, confounded apparent effects, and genuinely insufficient coverage. Constantly answering “inconclusive” must not pass cases where a supported answer is required. An evidence-bound model judgement is not a gold label; the held-out simulator/oracle owns ground truth.

### Fairness and three separate evaluation tracks

1. **Mechanism qualification:** deterministic injected events in ALG, with exact durable-state and side-effect assertions. No model-quality ranking.
2. **User-facing comparison:** native Build versus default ALG, both free to use their shipped capabilities, including native Build delegation, checkpoints and files. Same models, tasks, fixtures, equivalent service accounts in isolated matched namespaces, source visibility, explicit rules, budget and host version. Build receives the same raw recipe/job/lookup/validation/read primitives; ALG adds its implementation under test, not exclusive evidence. Report natural tasks and tasks with predeclared injected environmental faults separately; the latter are conditional stress comparisons, not estimates of everyday failure frequency.
3. **Ablation after a signal:** same ALG graph/criteria with one component changed (durable reuse, compact selection, or targeted review). Do not mix all changes and credit a checker prompt for the result. The existing checker is already adversarial; “targeted” is an extra mandate.

Inject environmental faults at externally recorded milestones, not at an ALG-specific node index. If one arm never reaches a milestone, record non-exposure and its actual task outcome; do not manufacture a comparable interruption or exclude the pair from its assigned scenario. Follow the per-track compaction/restart protocol below without erasing native Build's durable files. Human/engineer checkpoints must be identical and predeclared; evaluate to the checkpoint or supply the same scripted operator decision to both, never grant ALG an exclusive approval.

Freeze original criteria and the external oracle. Internal model-authored criteria may vary in the user-facing track; report that fidelity rather than treating it as a controlled checker comparison. Disallow reading oracle files for both arms, not normal project inspection. Do not require Build to emit ALG's private schema or forbid it from implementing a competent recovery strategy.

## Evaluation sequence and decision rules

1. Finish the mechanical fixes and deterministic admission/recovery matrix on Windows and Linux, including criterion-specific verification coverage and required before-work evidence captured before writes. Passing the earlier capability-admission slice alone does not satisfy this gate.
2. Qualify host/skill/service discovery using the synthetic provider in both arms. Separate authentication/transport failures from model-quality outcomes.
3. Freeze a **discovery pilot**: the six workloads above × two arms × one run = 12 trials, one fixed hosted model/configuration, seeded counterbalanced arm order, no targeted third arm. Keep the existing eight-minute/40-turn/200k reported-component thresholds for the continuity controls; freeze a separately named shared envelope for hard cases before issuance. Record overshoot and the limitations of that unit. Historical token thresholds are monitored, not hard provider-call or invoice ceilings. Reserve allowance for both halves of a pair and issue the pair before either arm plans or runs admission. No automatic replay or asymmetric budget top-up. Reaching a threshold is an outcome, not permission to enlarge it mid-cohort. No local Gemma.
4. If a concrete benefit appears, freeze a **qualification rehearsal** with fresh variants: two variants of each of the four challenge families plus both controls = ten pairs/20 trials. The eight challenge pairs are fresh at issuance, but become development evidence once inspected. This establishes the apparatus and estimates variability; it is not a powered superiority claim. No tuning during the batch; retained losses and setup failures remain visible.
5. Freeze a separate powered confirmation only after the work-package and evidence gates below pass. Fix the workload population, resource tiers, product/model identities, sample size, analysis and spending ceiling before issuing a trial. Confirmation data cannot tune the candidate being confirmed. The stronger requirements below replace the earlier assumption that twenty trials would suffice.
6. Report paired outcomes and uncertainty. A chosen example can illustrate an observed win but cannot establish superiority. Cross-model generality requires a separately bounded second-model check after a signal, not silent model substitution. A blocked or inconclusive result is publishable; it is not authority to change the hypothesis, add attempts or enlarge the budget mid-cohort.

Primary outcome: independently verified task completion at the preregistered practical hard-task ceiling, over all issued pairs. This is a capability outcome, not a minimum-cost score. Issue occurs before either arm's task planning/admission; admission rejection of an eligible task, timeout and budget exhaustion remain unsuccessful issued trials, with distinct cause labels. Deliberately impossible admission fixtures qualify mechanics and are not in the competitive workload population. For intentionally unresolved cases, a correctly bounded unresolved conclusion can be the required deliverable. Supplement with false acceptance/rejection, duplicate accepted computations, retained-work reuse, schema/parse/setup/capability failures, restart success, unknown-outcome recovery, tool/model calls, complete usage components and cost coverage, final-report contract violations, elapsed/active time, peak resource use and cleanup. Record actual graph/checker/reuse participation: an ALG-configured agent that solves a task directly without invoking those components does not demonstrate their benefit.

Do not use one blended score to hide a correctness loss behind speed. Report successful tasks and all issued pairs, including unrun or unscorable arms; count failed work in cost per verified outcome, and mark it undefined when no tasks pass. Bound paired effects over genuinely unknown outcomes and do not declare a winner if those bounds change the conclusion. Compare data-service work units and reported model usage separately; if economics are modelled, show the explicit prices and break-even range instead of inventing invoice totals.

## Next implementation slice and exit criteria

Task-contract admission, capability-compatible compact routing and original-criteria provenance are already implemented. The next product slice is **criterion-specific evidence coverage before edits**, building on those contracts and current-user source capture. Reuse existing preservation snapshots, execution receipts and evidence references rather than add a second verifier or store. Recursive graphs, automatic strategy promotion, a shared meta-brain, a new datalake engine and OpenCode V2 are outside this slice.

Exit when each declared critical criterion identifies an adequate observation and its collection phase; required pre-edit evidence is captured before writes; original baselines and coverage survive retries/compaction/restart; and unavailable evidence cannot be replaced by a model assertion or a later file read. Host checks establish declared proof compatibility and timing, not perfect interpretation of user intent. Retain the original request for semantic review. Scope collection to authorized relevant paths/results, not an indiscriminate copy or hash of the data lake.

Feedback must separate a real defect, a missing collectable post-work observation, a stale/insufficient observation and an unavailable prior baseline. Recover valid recorded evidence or perform the needed validation without rerunning already-correct producers; otherwise return a precise blocker. Qualify both successful paths and omitted-baseline/coverage failures locally through actual OpenCode host integration on Windows and Linux. Then complete sustained-execution/accounting and comparative-harness prerequisites under realistic hard-task headroom. Merge readiness still requires applicable local checks and an honest statement of unqualified offline-package/production-service boundaries; a hand-picked model win is not a release gate.


## Development work packages

The product objective is a higher rate of independently verified completion on difficult, multi-phase engineering and data investigations given practical, equally available headroom. More effort is acceptable when it buys reliable supported solutions; lower cost is a separate objective. Reliable recovery, evidence coverage, productive falsification and fewer repeated expensive operations are candidate mechanisms. General superiority on every task, every model or an actual factory is not the claim.

Target a **15 percentage-point improvement** in verified completion on the declared difficult-workload population as a practically useful development objective and planning alternative. It is not a minimum observed effect used to select significant results, a lower-confidence-bound requirement, an observed effect or a guarantee. Positive benefit, meeting this development target and deployment eligibility are separate conclusions. Report absolute completion as well: a relative improvement from a very low success rate is not sufficient for release. Freeze the deployment acceptance floor and its workload scope before confirmation; do not choose it after seeing scores. Keep simple controls to detect unnecessary orchestration cost.

| Package / sequence | Concrete delivery, reusing current code | Exit evidence |
| --- | --- | --- |
| H0 — trustworthy measurement, in parallel with P1 | Extend existing build-benchmark fixtures, transport and metrics; separate contestant, service and grader; qualify terminal compaction, final usage, cleanup and frozen identities | Deliberately wrong artifacts fail; equivalent valid artifacts pass; unavailable evidence cannot become zero/success; both native hosts pass deterministic fixtures |
| P1 — task admission, scope and verification coverage | Typed contract in existing planning/run records; compatible producer; original criteria separated from advisory findings; criterion-to-observation coverage and required pre-edit capture; compact route exposed without overriding an explicit graph | Impossible plans spend zero child calls; required before-state exists before writes; missing evidence never becomes a claim; valid tasks work; revision/resume preserves accepted scope and baseline; legacy behavior explicit |
| P2 — durable continuation | Existing run/attempt, skill/context and investigation records project one active task with evidence, procedure versions, hypotheses, coverage, pending intent and next action | After compaction/restart, compatible results reused, changed results invalidated, unknown submissions reconciled and approval revocation enforced; no reset of attempts or job costs |
| P3 — sustained execution and effort accounting | Shared task identity and cumulative allowance; distinguish estimates/soft targets from operator hard limits; reserve final checking/reporting; attribute resource use and retrieve bounded evidence | Useful investigation can continue within admitted headroom; child/retry/compaction costs counted; late usage and overshoot explicit; hard service limits enforced; repeated planning cannot replenish allowance |
| P4 — stronger checking and bounded graph adaptation | Original-claim identity, hypothesis-specific probes, cited raw evidence/receipts, safe pending-node revisions and evidence-based template selection | Wrong-but-plausible answers rejected; correct and insufficient-evidence controls handled; bounded retries; no criterion weakening, completed-node rewrites or permissions expansion |
| Q1 — headless platform qualification | Full plan → work → check → compaction/restart → continuation on the installed candidate in PowerShell and native Bash | Same source/package identities; real hooks exercised; archived receipts readable; no loss of committed results, explicit in-flight uncertainty, no orphaned owned processes or retained temporary auth; no model needed for mechanical cases |
| E1 — difficult development cohorts | Twelve-trial discovery, then twenty-trial rehearsal, using the qualified harness and frozen per-batch candidate | Every issued attempt has an outcome and cost-coverage status; defects produce minimal regressions; no post-hoc grade/limit changes |
| E2 — sealed confirmation | Independent fresh task instances, one fixed candidate/model configuration and preregistered analysis | Complete retained cohort; uncertainty and guardrails reported; superiority claimed only within the demonstrated scope |
| E3 — portability and adoption | Separately bounded second-model confirmation, natural-use checks and package deployment qualification | No model-name routing; gains do not depend on fixture names or hidden hints; exact deployable artifact verified before adoption |

P2 and H0 may proceed independently of P1 where interfaces already exist. P3 depends on the accepted task identity. P4 depends on P1's criterion authority and P2's evidence validity; it must not become a second orchestration framework. Run the small development pilot once H0/P1/P2/P3 and the existing checker qualify; do not wait for speculative graph features to begin learning. Add P4 features individually when evidence identifies a need. E2 waits for the final selected candidate and all applicable qualification checks.

### P2: what must actually survive context loss

A bounded context projection points to durable facts; it does not contain the whole knowledge map. Persist or reference:

- The accepted task and phase, exact original criteria, project/environment identity, and current graph digest.
- Required skill identity, content digest, applicability basis and approval/revocation state. After resume, revalidate and load the applicable version through existing tools; memory of a prior approval is insufficient.
- Hypotheses and their status: proposed, tested, contradicted, unresolved, or supported within a stated scope. A model conclusion never turns into a verified fact merely because it was saved.
- Completed query recipes, normalized parameters, source snapshot/revision, population/time window, result manifest/page references and coverage. A negative search records where it looked; it is not evidence that the entire lake lacks a relationship.
- Pending remote intent/job identity and reservation, active leases, completed sibling outputs, uncertainty, and the next allowed action.
- Cumulative attempts/calls/known service cost, missing telemetry and reserved verification allowance.

Add only missing fields to the existing owner records. Keep the run, investigation ledger and skill approval source authoritative for their own domains. Do not duplicate them in a competing session database. Resume checks identity and freshness before projecting context. Retrieval on a changed task/phase or explicit invalidation is bounded; do not invoke an LLM on every token to maintain a world model.

Distinguish harmless rereading of a small manifest from repeating an expensive accepted computation. Reuse requires compatible scope and source validity, not a similarity score. A changed source should invalidate only dependent results where dependencies are known; unknown dependencies require conservative revalidation. Do not invent automatic replay when an operation has an unknown side effect.

Qualify the service's actual idempotency/lookup guarantee using an identity persisted before submission. If it cannot reconcile a lost acknowledgement, preserve the pending intent/reservation and expose a typed blocker. Likewise, check the authoritative skill approval state at the next governed action, including within a resumed session; unavailable approval state is a blocker. This is the V1 application boundary, not a claim to revoke a skill already copied into model context or prevent arbitrary shell actions outside governed paths.

### P4: make graphs better without rewarding more agents

Start with existing compact, diamond and fixed investigation templates. Model selection supplies a reason and admitted task contract; host policy rejects incompatibility. Add probes only for concrete uncertainty: contradictory observations, a risky join, a source change, unverified test execution or competing causal explanations. Bound probe count and cost before launch.

A probe asks a falsifiable question and returns evidence, not revised acceptance criteria. A fresh final checker receives the original claim, required deliverables and independently accessible source/command evidence. It can request one bounded missing observation or return a precise blocker under existing attempt limits. Fresh sessions reduce shared history; they do not establish statistical independence from the implementer's model or evidence.

Test adversarial checking on three kinds of cases: a real defect, a correct solution with a plausible distraction, and evidence that cannot resolve the claim. Measure false acceptance, false rejection and unnecessary repeated work. An always-rejecting checker fails the positive controls; a verbose skeptical memo does not count as defect detection. Compare ordinary versus added targeted review with the same total allowance and an external oracle.

For custom graphs, reuse existing owner/digest-checked pending-node revisions. No revision may weaken original criteria, remove an established checker, rewrite attempted nodes or increase the task allowance. Managed data-investigation graphs remain fixed in this increment. Candidate templates and skills can be proposed from development failures with provenance and cost evidence; they cannot promote themselves or train on sealed confirmation results. Automatic graph promotion remains later V1 design, gated by an explicit future contract.

## Hard benchmark specification

Hardness must come from genuine dependencies, ambiguity and recovery requirements. Do not create difficulty through an impossible deadline, missing mandatory tools, an inaccessible necessary fact, arbitrary output spelling or a restriction applied only to Build.

Before freezing a confirmation population, the fixture custodian must demonstrate a viable reference solution and recovery through the contestant-visible interface and Build-accessible primitives within the proposed allowance. This proves a feasible path, not that Build's model will choose it. Test alternate decompositions and identify which faults are realistic synthetic assumptions. Freeze family weights and fault mix before seeing holdout outcomes; a recovery-heavy selection supports a recovery-heavy claim.

### Flagship scenario: an interrupted semiconductor defect investigation

Give each arm the same engineering request: investigate a bounded particle/defect excursion, identify the best-supported explanation or the exact unresolved alternatives, provide a reproducible report, and complete a clearly scoped downstream correction when the case requires one.

The synthetic workspace contains:

- An approximately 11,000-entry catalog with incomplete enrichment and a much smaller coherent data fixture. Schemas, logs, lineage and data access are discoverable through the same documented MCP tools. Missing map edges can be established from evidence; their initial absence does not hide essential data.
- Several repositories representing ingestion, an API and a client/report consumer. Some cases require a coordinated fix and compatibility tests; investigation-only cases do not silently acquire a coding requirement.
- Wafer, lot, chamber, recipe and maintenance observations with declared units and times. Cases include duplicate event rows, time-zone boundaries, changing schemas, missing logs and plausible decoy correlations.
- A service with recorded query work units, asynchronous status and lookup, result manifests, bounded pages, validity checks and reviewed refresh. Use the current datalake-mcp adapter contract and native mapping seam; a simulator does not qualify the real air-gapped service.

Predeclare a small number of observable disruptions. Examples: accept one expensive query but lose the acknowledgement; restart after a durable partial result; change one source revision; revoke or update a procedure before a later action. Use service/host milestones shared by both arms. A necessary changed procedure is obtainable through the same source. If authorization cannot be obtained, a bounded stop can be the required outcome. No special operator assistance or secret recovery hints for ALG.

Correct completion requires the externally specified analytical answer, valid source/time/population scope, uncertainty and contradictions, reproducible bounded query/result references, requested files, actual relevant validation and no prohibited mutation. A coding change cannot pass only because a report says tests ran. An investigation cannot pass only because its JSON matches a schema or its citation names a real file.

Include matched cases where the apparent culprit is true, confounded, or not identifiable from available evidence. Require a supported conclusion when evidence is sufficient; require a discriminating next measurement when it is not. Do not demand a unique root cause from deliberately insufficient data or treat simulator causality as observable proof when the visible observations cannot identify it.

The flagship combines multiple family stressors. Use it first as a development integration case, scored separately from the four-family primary cohort. Its score cannot be added to that primary result after observing it. To make it a future primary family, preregister the changed population and fresh instances.

### Difficulty ladder

| Tier | Purpose and workload | Advancement rule |
| --- | --- | --- |
| Controls | Existing small edit and staged report with original criteria and limits | Retain failures and overhead; do not discard because Build wins |
| L1: bounded hard case | One deep multi-source problem with a misleading hypothesis or cross-repository contract | Tools and reference solution qualified; realistic discovery/verification headroom frozen for both arms; no injected restart needed |
| L2: recovery and drift | L1 plus one accepted/lost response or one source invalidation, one compaction and one restart where specified | Both arms receive matched disruption and access; evidence freshness and duplicate work scored |
| L3: sustained integration | Flagship with successive phases, changing evidence and multiple bounded context transitions | Separate long-session/resource envelope frozen before issuance; relevant recovery mechanisms already pass |

Use one stressor at a time before compound L3 tests, so a failure can be attributed. Keep a natural-use track with native automatic compaction settings enabled equivalently; imposed compaction is a separate stress track. A log marker alone never certifies recovery.

Each batch has one machine-readable protocol, validated before issuance:

| Track | Resource envelope | Native compaction | Imposed transitions |
| --- | --- | --- | --- |
| Continuity controls | Historical eight minutes / 40 turns / 200k reported components, with monitored overshoot disclosed | Auto/prune disabled as in the historical harness | Coding: none; staged report: one requested compaction and one restart at the preparation milestone |
| L1 natural hard cases | New shared hard-case envelope frozen on development evidence | Same enabled host settings for both arms | None; record naturally occurring compaction |
| L2 recovery stress | Shared hard-case envelope, one cumulative allowance across recovery | Same enabled host settings for both arms | One requested compaction and one restart at declared milestones; native events counted separately |
| L3 integration qualification | Separate bounded envelope below | Same enabled host settings for both arms | Up to six requested compactions and two restarts at frozen milestones; non-exposure retained |

All tracks use seeded counterbalanced arm order; the seed and order are committed before execution. Record native and requested events separately, and never top up a run because natural compaction consumed allowance. The twelve-/twenty-trial batches freeze which hard cases use L1 or L2 before launch. L3 remains separate unless a later primary population explicitly includes it.

L3 qualification initially proposes a **two-hour active-work cap, up to six requested compactions and two host restarts per arm**, under one cumulative model/service allowance. These are future upper bounds, not a command to run or to consume all of them. Stop terminal work immediately; idle waiting and repeated trivial prompts do not establish useful endurance. Choose workload volume and the finite resource allowance on development cases and freeze them before confirmation. If the case cannot reach the planned milestones, report non-exposure and outcome rather than forcing extra model calls. Do not extend the old eight-hour soak or start a new soak from this document.

### Resource fairness

Keep the earlier eight-minute/40-turn/200k reported-component envelope for the small continuity controls. A deliberately larger hard case may have a larger **new, prospectively named envelope shared by both arms**. This is a separate benchmark version, not a rescue of failed controls. Set it from known task work, development timing and the intended deployment constraint, then lock it. Neither arm receives an ad hoc top-up.

Count all root, child, retry, checker, summary and compaction calls. Record tool/service work independently of model usage. Same provider/model/reasoning and output limits, effective permissions, skills, service concurrency/rate limits, context configuration, host version and external deadlines. Native Build retains its shipped delegation and durable files; ALG receives its additional plugin tools because that is the intervention. Neither receives an exclusive gold answer, source, cache or engineer decision.

For confirmation, H0 must qualify an arm-neutral boundary that admits and stops host/provider requests and service work for both arms. ALG's internal task budget alone is not comparable enforcement. Freeze maximum in-flight requests, cancellation/grace behavior, and whether outputs completed after cutoff are ineligible or attributable to a pre-admitted request; apply the same rule to both. Charge and report all work, including late results. If complete token/cost limits cannot be enforced, claim equality only for the request, time, concurrency and service-work limits actually enforced; treat delayed/missing usage as telemetry, not a fictitious hard ceiling.

Define duplicate work using external service-observed operations, scope, source revision and justified purpose, not ALG private work IDs or a required query decomposition. Qualify with an alternative valid query strategy, legitimate refresh, independent verification and a true repeat. Identical idempotent submit attempts need not be duplicate accepted computations. Report work units and charges so a different but correct decomposition is evaluated by actual resource use.

Use a fresh matched namespace per arm; preserve it only within that trial. Separate setup/compilation from measured task time consistently and report cold/warm behavior. Freeze and disclose cache warm-up policy. Randomize order within paired trials, avoid overlapping competing trials on this host, and record load/provider changes. A changed model revision or configuration invalidates the predeclared cross-run comparability; split versions rather than silently pool them.

A capacity or accuracy advantage must be assessed with equal access to the declared practical ceiling; actual consumption may differ. ALG does not have to be cheaper to demonstrate a capability gain. If both methods solve reliably and ALG only spends more, the study has not shown a capability advantage at that ceiling. For a resource frontier, retain every issued tier and use the predeclared analysis rather than selecting a favorable slice. If cost efficiency is also claimed, require adequate billing coverage or report service work units and known model components separately. Never call a zero host-reported price free usage.

## Independent oracle and anti-false-positive gates

The benchmark is a measurement tool with its own failure modes. Its correctness is a prerequisite, not something an ALG pass proves.

1. **Physical separation.** Keep gold labels, hidden tests, fault schedule and scoring code outside the contestant's accessible filesystem and credentials, using a real OS user/container boundary or an external grader. Prompt prohibitions, obscure paths and an OpenCode external-directory setting alone are not isolation from a shell. Do not leave generator seeds/gold answers in the contestant repo or inherited conversation. Both arms get the same allowed task information.
2. **Independent reference.** Use a small transparent reference computation and independent invariants for the analytical answer, rather than sharing ALG's implementation with its oracle. Cross-check distinct-wafer counts, time intervals, joins and cost accounting by a second implementation/manual enumerated fixture. Test that required answers are identifiable from visible information.
3. **Oracle mutation cases.** Seed wrong denominator, timezone edge, duplicate join, wrong source revision, invented citation, stale result, missing file, skipped command and modified protected input. Each must fail the relevant criterion. Seed equivalent valid representations and legitimate inconclusive answers; these must pass when the task allows them. A list of required words is not an analytical verifier.
4. **All necessary criteria.** Pass requires all critical task criteria; unchanged protected files cannot compensate for a missing deliverable. Report artifact correctness, workflow completion, contract integrity, scientific adequacy, metering coverage and operational cleanup separately.
5. **Externally observed actions.** The service ledger establishes accepted computations, idempotency and charges; the host establishes commands/exit state and compaction completion. Self-reported tool use, an ALG checker verdict, node success or JSON validity is not the external gold label.
6. **Blinded discretionary review.** Automate objective checks. Where semantic review remains necessary, freeze a rubric, hide arm/model labels where possible, use two independent reviewers and adjudicate disagreement without knowing the aggregate winner. Keep uncertainty visible. An LLM grader can assist but cannot be the only authority for the primary pass.
7. **Tamper qualification.** Try to read oracle/seed files, alter scorer inputs, forge receipts and bypass service counting in sacrificial fixtures. Inability to demonstrate isolation or immutable evidence blocks confirmation. Report oracle leakage; do not repair the leaked cohort into a clean result.
8. **Apparatus failure injection.** Prove the runner handles unavailable skills, auth failure, late/missing usage, truncated streams, scorer failure, orphaned processes, source drift and absent compaction summaries. Unknown evidence remains unknown. Preserve exact source/harness/config/task/oracle/runtime hashes and all failed invocations.
9. **No hidden exclusion.** Enumerate scheduled, issued, unissued, stopped, invalid and completed trials. After issuance, timeout, provider fault and ALG failure stay in the all-issued operational denominator. Validity and task quality are separate fields. A broken measurement can block inference but cannot selectively remove an ALG loss; publish best/worst-case bounds for unknown outcomes and do not declare a winner if they change the conclusion.
10. **Equal operator boundary.** Freeze any approval/checkpoint decision and its trigger for both arms. Native Build is not failed for lacking ALG's private receipt schema. Extra manual recovery is measured as intervention, never silently supplied.

For protected paths, the task must state whether it forbids final differences or any mutation. The existing two-file scorer checks final differences. If a future task forbids transient edits, qualify a host-observed write policy or trace for both arms; do not claim that comparing final hashes enforces that stronger rule.

## Evidence and improvement rules

### Compaction frequency and retention across long tasks

Measure at the **logical task** level, with explicit session, child, restart and reassignment lineage. A new host session or handoff does not create a fresh denominator, erase earlier failures or replenish the task allowance. Report both root-only and whole-task counts; child session turnover is not compaction. Preserve host-native and harness-requested compactions separately. A persisted marker alone is not success: require a new marker, linked completed summary without host error, and the corresponding continuation. Keep requested, accepted, completed, failed, unknown and continuation-verified counts distinct.

Record event times and model/context-limit identity. Report completed compactions per 100 assistant turns and per active-task hour, with raw numerators/denominators; also report per elapsed hour so service waits are visible. Active time excludes explicitly observed suspension or external-wait intervals, not inconvenient slow computation. Overlapping child spans are unioned for task wall time; separately summed child time is not the same unit. Report time/turns to first compaction and intervals between successive events. Input-volume-normalized rates require complete compatible usage coverage; otherwise that rate is unavailable. Exclude preflight/setup consistently for both arms, and report compaction request latency, summary size, known model usage, unknown usage and compaction's share of measured task cost separately. Missing host usage is never zero billing.

**A high compaction rate is not itself information loss.** Before each declared boundary, freeze an external checkpoint of the facts needed for the next part of the task, using references and digests rather than copying sensitive contents. Stratify these obligations: original goal/criteria and phase, approved skill version/applicability, source and schema versions, validated positive/negative findings, unresolved hypotheses, evidence/result references, pending remote intent/idempotency identity, consumed allowance, and next permitted action. Also record superseded and revoked facts that must *not* be reused. Keep the evaluator's expected facts outside the contestant's accessible context.

After the boundary, measure distinct layers:

| Layer | Observation | Interpretation |
| --- | --- | --- |
| Durable state | Exact required records and digests remain loadable under the same task identity | Persistence integrity; not proof the model used them |
| Context projection | Correct required pointers or selected facts appear in the actual request | Availability; an omitted fact can still be recovered on demand |
| Retrieval | The resumed agent retrieves the current authorized version when the task requires it | Recovery performance and retrieval cost |
| Applied behavior | Externally scored action/conclusion obeys the criterion, evidence, skill and pending intent | Task-relevant retention; model assertions alone are insufficient |
| Repeated work | Service-observed duplicate accepted computations and their work units after the boundary | Avoidable work only after checking scope/revision and justified independent verification |

Classify each tested obligation as retained, recovered-on-demand, stale/wrong, durably missing, or unresolved/unobserved. Context omission by itself is not a lost fact. A record can survive on disk while the model applies a stale version; report these separately. Report critical-obligation violations individually, micro/macro retention with denominators, first-boundary versus cumulative failures, recovery latency/calls, duplicate work and task outcome. Do not average a lost pending-submit identity away with many easy retained facts. Unknown probes do not enter the numerator as successes. Diagnostic probes themselves consume budget and alter context; keep passive observation separate from active recovery probes and apply the same schedule to both arms.

Use the existing L1/L2/L3 ladder and its limits. L2 includes the declared compaction/restart and a predeclared handoff variant; L3 can assess cumulative retention across the already proposed bounded long task. This addition does not authorize extending old soaks, consuming every upper bound, or starting an extra paid cohort. Synthetic qualification must include successful retrieval after context omission, an altered criterion, stale/revoked skill, lost pending job identity, duplicate expensive query, absent/error summary and incomplete usage. A real-model comparison follows apparatus qualification.

Association after compaction is not causal attribution. To estimate the *incremental* effect of compaction, use predeclared paired variants of the same incident with and without a requested compaction at a comparable work milestone, equal resource allowance and independent fresh namespaces. Record unavoidable native compactions in both arms. Analyze repeated boundaries within a task as clustered observations, not independent trials; report task-level uncertainty and model/context strata. Separate evidence loss, failed retrieval, invalidated evidence and ordinary reasoning error before deciding whether to change ALG's projection, retrieval, skill loading or graph policy.

### What “ALG is better” will mean

The primary claim is scoped: **on the frozen difficult-workload distribution, with the specified model/host and equal access to the preregistered practical ceiling, ALG completes more tasks correctly**. Actual consumption may differ and is reported separately. The mixture of the four challenge families, difficulty tiers and any fault exposure must be fixed before confirmation. A fault-heavy cohort establishes resilience under those faults, not their prevalence in ordinary work.

Primary outcome is the paired difference in externally verified whole-task completion, counting all issued trials as above. Define pass before execution, including which cleanup/integrity conditions are mandatory and how unknown data affects inference. A useful unresolved result counts only on cases whose external specification calls for it. Record whether ALG's graph, reuse and checker mechanisms actually ran; a direct solution is still an arm outcome but does not demonstrate those mechanisms.

Do not accept a speed or cost advantage that hides lower correctness. Also require the predeclared absolute completion floor and critical safety/integrity gates for a deployment recommendation. Any observed prohibited data mutation, cross-tenant leak or false certification of required execution blocks adoption until fixed and requalified. Zero observed violations is not a universal safety result.

Keep easy-task completion and overhead as explicit guardrails. If ALG is worse on easy controls, document a narrower recommended scope or fix routing; do not average the regression away. Natural-use, injected-stress, different operating systems and different models are separate reported strata unless a pooling rule was frozen in advance.

### Sample size, uncertainty and stopping

The twelve-trial pilot and twenty-trial rehearsal diagnose behavior; neither can guarantee proof. Repeated prompts on the same seeded incident are not independent tasks. Choose independent incident seeds and meaningful variants; keep repeats nested under their incident and analyze the incident as the unit. Do not inflate the sample with nodes, attempts, assertions or repeated measurements of one case.

Before a confirmation starts:

- Freeze one primary population/metric, the minimum worthwhile effect, absolute completion floor, guardrails, exact analysis, trial count and maximum spend. Draw incidents from a declared distribution; a convenience collection of selected Build failures is not that population.
- Calculate power across plausible paired discordance rates and a range of effect sizes using versioned code. A two-sided exact paired test with controlled type-I error and at least 80% planning power is the default target. Select the actual confidence-interval method and validate its coverage under the same dependence/stratification rules; do not treat independent-binomial intervals as paired evidence. Simulate the actual benefit/target/adoption decision rules under the frozen family mixture, rather than using power for rejecting zero as power for every deployment gate.
- Illustrative calculation only: if independent pairs have ALG-only success probability 0.30 and Build-only success 0.15, exact conditional McNemar positive-rejection power at two-sided 0.05 is approximately 9% at 20 pairs, 45% at 80, 79% at 160 and 87% at 200. The calculation sums over discordant counts D distributed as Binomial(N, 0.45), and ALG wins conditional on D distributed as Binomial(D, 2/3); the rejection threshold is twice the upper Binomial(D, 1/2) tail at most 0.05, in ALG's direction. This is not an estimate from the small observed benchmark and does not license 400 model trials. It explains why a few favorable examples cannot prove a 15-point advantage. The actual confirmatory size may be larger, smaller, or unaffordable; then narrow the claim or report exploratory evidence.
- Use one fixed sample and one final primary analysis. No repeated significance checks, stopping at the first win, automatic sample-size extension or trying models until one passes. Operational integrity/spending stop rules can end early, in which case inference is qualified and no positive efficacy claim is made.
- Predeclare correction/gatekeeping for any additional confirmatory metrics, models or populations. Cost, latency, checker ablations and family slices are descriptive unless separately powered and controlled. A second model's win cannot rescue a failed primary result.
- Limit this initiative to one primary confirmatory attempt unless a family-wise error budget of at most 0.05 across candidate attempts is allocated before the first one. If repeated candidate confirmation is intended, freeze a finite correction or alpha-spending rule and power each attempt at its allocated level. Restarting with a fresh 5% test after each failure until one wins is not permitted. A future replication or revised scope must disclose the earlier attempts and its own status.

A positive-benefit claim requires the frozen primary analysis to reject no benefit in ALG's direction and its compatible paired interval to exclude zero. Report whether the point estimate reaches the fifteen-point development target, without converting that comparison into proof of a fifteen-point true gain. That stronger claim requires the lower bound to exceed fifteen points and a different power plan. Deployment eligibility separately requires the frozen absolute-completion and integrity guardrails. Report all three decisions, the estimate, interval, denominators, all discordant pairs and missingness.

Confirmation fixtures and gold data remain inaccessible to the implementing agents until that evaluation is closed. If there is no separate custodian/isolation boundary, call the run development validation, not a blinded holdout. After inspection, those cases become regression/development evidence; future confirmation uses new sealed incidents. If an oracle defect is discovered, retain the original cohort, mark it invalid for the affected claim, fix/qualify the grader and freeze a new cohort. Never silently rescore the old data into a victory.

### Failure-driven development loop

For every unsuccessful or expensive development case:

1. Preserve the trace and smallest reproducible evidence: task/graph revision, phase, source and skill versions, remote intent/result, attempt reason, resource observations and exact cutoff.
2. Classify the host-observed cause: apparatus invalidity; admission/capability error; mechanical persistence/recovery failure; output contract; scientific/code error; checker false acceptance/rejection; avoidable repeated work; budget/overhead; provider availability. Do not label everything model variance.
3. Reproduce mechanics with deterministic fixtures first, minimizing model calls. Define the invariant that should have held and the affected ownership boundary.
4. Make the smallest model-agnostic repair in the owning component. Add a regression that fails before and passes after the fix, plus a neighboring negative case. Preserve earlier failure receipts.
5. Run affected local Windows/Bash checks; broaden to full-suite and installed-package checks at candidate freeze. Use a development counterpart under unchanged criteria to assess behavioral improvements; report both versions and all attempts. Do not rewrite history or cherry-pick the best seed.
6. Review cost and mechanism participation. If a feature consumes more calls without improving correct completion or required recovery, simplify, disable by default or remove it. A targeted checker is retained for demonstrated value, not because its output sounds skeptical.
7. Freeze the candidate before confirmation. A material runtime, prompt, skill, model, graph policy, scorer or budget change starts a new cohort. Failed sealed cases can improve the next candidate but cannot also confirm it.

A durable failure register links incident → invariant → reproducer → fix commit → local checks → development outcome → remaining uncertainty. Keep it in the existing evidence/report workflow, not another runtime store. Only observed failures and measured effects support promotion; the simulator's hidden labels, holdout answers and model names must never become production routing rules.

### Delivery order and stop rules

P1 now has task-contract admission, criteria identity, compatible compact work, bounded current-user source capture and criterion-bound observations committed before the first child. The pending 0.5.10 increment adds P3's shared dispatch allowance in the existing root checkpoint, including reservation-before-launch, cumulative phase/retry accounting and ownership-transfer continuity. Qualification must test those boundaries through actual V1 child dispatch, compaction and restart on both platforms. This does not complete P3's whole-host usage accounting: a dispatch reservation is not a provider call, token allowance or invoice cap. Deterministic P2 recovery and paired long-task behavioral retention remain separate claims.

H0 now has six hard development fixtures and a shared bounded loopback service for both arms. Positive references, deliberately wrong submissions and tampered submissions must qualify before any paid development cohort. The runner must bind the qualification receipt to the frozen fixture/service/grader sources, preserve all issued outcomes, use a predeclared equal headroom envelope and retain historical controls unchanged. Same-user execution is development evidence only; OS isolation and independent confirmation remain outstanding. Add P4 probes/adaptation one at a time in response to measured failures. Do not expand graph complexity while admission, evidence recovery or metering is failing.

A merge/release needs the repository's applicable full local checks and a clean candidate-specific installed-package verification on both platforms. A competitive advantage needs separate comparative evidence. These are different gates: do not merge broken mechanics because a model trial wins, and do not describe a mechanically green candidate as proven superior.

An evaluation cycle closes when its candidate, evidence gates and comparative decision are recorded, including a legitimate mixed, negative or inconclusive conclusion. That closes the measurement, not the capability-improvement program and not an unimplemented work package. An unproven candidate returns to fresh development cases and targeted design repairs. A later superiority claim needs a newly frozen candidate and independent confirmation under the repeated-testing rules above; earlier losses remain published. Continue improving toward demonstrated capability without requiring any particular study to name ALG the winner.

### Bounded live retention diagnostic

The comparison gate must not prevent useful development measurements. `scripts/live-retention.ts` runs one isolated V1 host against a seven-phase synthetic analysis project with an external fixture scorer. Its frozen plan records the runtime, executable, harness and fixture hashes before model generation. Every issued phase, failure and partial boundary remains in evidence; there is no automatic paid rerun or budget reset.

The initial envelope is 45 minutes, 120 observed assistant turns, 600,000 cumulative reported usage components and a configured 4,096-token output limit. The usage-component sum includes reported cache/reasoning fields and is not an invoice-token estimate. Host polling may overshoot the turn/usage thresholds; both limits and overshoot are reported. Up to six requested compactions and two restarts exercise actual host recovery. Natural compaction remains enabled at the model's catalog context capacity; no artificial context reduction or time padding is used.

Freeze expected obligations and the independently scored previous artifacts before each requested boundary. Score the resumed phase from its artifacts and executed utility/tests. Compare only unchanged obligations that demonstrably passed before the boundary; changed phase IDs, next actions and procedure revisions are new compliance checks, not forgotten facts. A later recovery does not erase an earlier failed phase. Separately preserve host marker/summary/continuation links, skill-use calls and the final read-only database census. Unknown or incomplete exposure cannot become a zero-loss result.

This measures observable task compliance with durable mission files available. It does not measure hidden context contents, establish compaction as the cause of an error, test expensive MCP searches, or demonstrate superiority to Build. Report actual task duration, observed natural/requested events, restarts and scored boundary exposure. A completed short task is not a multi-hour soak. This development diagnostic does not replace the hard paired comparison or relax its confirmation gates.

### L2 implementation: separate exposure, handoff and restart

The [prospective L2 draft](evidence/hard-scope-20261113/l2-design-draft.md)
separates requested compaction from restart and controller handoff, keeps
failed continuations in the exposure record, and requires independently
established pre-transition behavior. It specifies missingness, common-eligible
obligations, native pruning and root-versus-session-tree accounting. It is not a
frozen or executed study. Commit `5500ad6` introduced independent summary
exposure. The [V1 long-session workload](v1-long-session-benchmark.md) now
implements the paired schedule, private live obligation collector, native
service action evidence and common-eligible reporting. Source-bound local
qualification and real-model execution are separate gates; implementation
alone supplies no measured information-loss rate or superiority result.

The first [real Luna L2 development cohort](evidence/l2-continuity-20261113/README.md)
is now terminal: Build passed 1/8 whole tasks; ALG passed 0/8, with five ALG
usage-limit stops. Seven requested summaries, two owned-run transfers and 12
host restarts were observed, with no native automatic compactions. All 16
cleanup/auth/source/global checks passed. ALG's one fully correct initial
checkpoint stopped before compaction, so semantic loss for a successful ALG
task remains unestablished. Original conditional observations include grader
weaknesses diagnosed during the run and are preserved as diagnostic evidence,
not promoted into acceptance or superiority claims.

Post-study repairs clarify delivery scope and template routing, require actual
expected job identities in retention checks, distinguish omitted actions from
missing telemetry, and make future output contracts explicit and retrievable.
The next measured repair is bounded execution provenance: independently correct
artifacts were rejected internally when truncated command evidence could not
prove the original submission/recovery. Qualify action references, truncation,
redaction and missing-evidence negatives before another frozen paired study.
Do not weaken the checker, count bookkeeping as a retained diagnosis, or extend
this cohort's original allowance. Sustained L3 and independent confirmation
remain outstanding.
