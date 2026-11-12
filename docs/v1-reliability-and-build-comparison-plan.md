# V1 reliability and comparison with native Build

Status: reviewed implementation plan, 12 November 2026. Baseline is PR #14 at `18e9cfe` (tested 0.5.5 runtime `373b8d0`). This document does not activate the planned runtime contracts or authorize new paid cohorts. V1 only; local Windows/PowerShell and native Ubuntu/Bash tests; no GitHub runners, Gemma, global configuration edits or merge.

## Decision and evidence

ALG should earn its overhead on tasks requiring durable recovery, bounded expensive work and independently checked evidence. It need not replace native Build for a small known edit. A benchmark designed to force Build to fail would not tell us which tool to use. Preserve easy controls, native Build delegation/checkpointing, all failures and identical external rules.

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

## First V1 increment: prevent impossible work before spending calls

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

Before model inference, reject research-only graphs assigned `preparation.md` or `report.json` in the project root; accept compatible compact graphs. Exercise ordinary/custom graphs, explicit read-only responses, internal artifacts, absent/denied host capabilities and legacy runs. Enforce the same rules at admission, relevant revision and resume boundaries without consuming attempts or resetting budgets.

Required preservation must retain the original before hash across retries; required execution must have a native or shell-gate receipt with honest missing metadata. No silent promotion of model claims. Criteria and deliverables survive compaction/restart byte-identically. Tests run locally on both operating systems; deterministic OpenCode host fixtures must cover the new tool arguments before any paid comparison.

## Second increment: measure and reduce orchestration overhead

First add observation, then choose a policy. Attribute calls and reported input/output/reasoning/cache components to root, child role, graph, attempt and phase. Record explicit prompt byte sizes, tool-result bytes, retries, setup time, checker work, and time waiting for remote jobs. Mark provider counts unavailable/overlapping where appropriate. Do not equate summed components with unique tokens or dollars. Review of the exact recorded Windows host found disjoint normalization (cache removed from input and reasoning removed from output), not demonstrated double-counting in the current collector. That host also normalizes missing usage to zero: numeric-field presence is not proof of complete upstream telemetry. Preserve the historical formula and caps.

Keep child inputs bounded and relevant. Avoid duplicating goal/criteria in both instruction text and wired inputs when a single authoritative copy suffices. Pass artifact references and bounded result pages instead of repeated large summaries. Benchmark any prompt/tool-surface reduction with original correctness criteria unchanged; removing verification to save tokens is not an improvement.

Make a plan display its necessary calls and remaining verification allowance. Reserve enough of the task's finite call budget to check and report rather than spend it all on exploration. Do not promise exact token forecasting from text length.

A multi-phase task must keep one host-owned task identity, accepted contract and cumulative allowance through continuation. Design this as a compatible extension of the existing root/task records, not a new database or arbitrary nested run tree. New plans, retries, compaction or graph revisions cannot reset the allowance. Reuse the investigation ledger's existing job/cost reservations rather than adding competing remote accounting.

Start with accurately observable call/attempt and elapsed limits. Provider usage is a separately labelled, potentially delayed observation; unavailable billing is never zero. Define crash reconciliation and in-flight overshoot before treating usage as enforceable. A hard dollar ceiling needs an independently enforceable provider/account control, not the current zero-valued cost field.

Acceptance: synthetic multi-phase continuations preserve the allowance, reserve final verification, avoid repeated compatible work and expose the exact reason for stopping. Report quality-versus-resource tradeoffs on the frozen easy controls before changing default graph selection.

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
| Expensive query with lost acknowledgement | Service accepts job, response is lost, host restarts at the service-side milestone | Correct final answer, one accepted semantic computation per authorized work identity, no duplicate charges | Existing intent/reservation/lookup ledger |
| Multi-repository contract change | API/schema/client fixtures, one failed validation and already-correct sibling work | Hidden compatibility tests, unchanged protected inputs, bounded repeated work | Explicit dependencies and focused feedback |
| Incomplete factory evidence | Synthetic 11k-entry metadata map, event logs, join-grain error, confounding and a stale source revision | Correct supported/unresolved conclusion, correct denominators/joins, cited current source versions, no unsupported causal claim | Bounded evidence, freshness checks and independent falsification |
| Partial investigation across restart | Two completed branches, one transient service failure, restart before synthesis | Correct synthesis using retained compatible results; no needless repeat of accepted searches | Durable branch results and reconciliation |

Keep data small and local; a large catalog tests navigation, not terabytes of simulated storage. Use an external simulator to count accepted computations/bytes/cost units, with latency as a separate declared scenario. Do not pad delays solely to make ALG look faster. Intentional independent verification, source changes and authorized refresh are not duplicate work.

For scientific cases, create matched negative controls: sufficient evidence for a true effect, confounded apparent effects, and genuinely insufficient coverage. Constantly answering “inconclusive” must not pass cases where a supported answer is required. An evidence-bound model judgement is not a gold label; the held-out simulator/oracle owns ground truth.

### Fairness and three separate evaluation tracks

1. **Mechanism qualification:** deterministic injected events in ALG, with exact durable-state and side-effect assertions. No model-quality ranking.
2. **User-facing comparison:** native Build versus default ALG, both free to use their shipped capabilities, including native Build delegation, checkpoints and files. Same models, tasks, fixtures, equivalent service accounts in isolated matched namespaces, source visibility, explicit rules, budget and host version. Build receives the same raw recipe/job/lookup/validation/read primitives; ALG adds its implementation under test, not exclusive evidence. Report natural tasks and tasks with predeclared injected environmental faults separately; the latter are conditional stress comparisons, not estimates of everyday failure frequency.
3. **Ablation after a signal:** same ALG graph/criteria with one component changed (durable reuse, compact selection, or targeted review). Do not mix all changes and credit a checker prompt for the result. The existing checker is already adversarial; “targeted” is an extra mandate.

Inject environmental faults at externally recorded milestones, not at an ALG-specific node index. If one arm never reaches a milestone, record non-exposure and its actual task outcome; do not manufacture a comparable interruption. Use one scheduled compaction and one restart for each relevant task, without erasing native Build's durable files. Human/engineer checkpoints must be identical and predeclared; evaluate to the checkpoint or supply the same scripted operator decision to both, never grant ALG an exclusive approval.

Freeze original criteria and the external oracle. Internal model-authored criteria may vary in the user-facing track; report that fidelity rather than treating it as a controlled checker comparison. Disallow reading oracle files for both arms, not normal project inspection. Do not require Build to emit ALG's private schema or forbid it from implementing a competent recovery strategy.

## Evaluation sequence and decision rules

1. Finish the mechanical fixes and deterministic admission/recovery matrix on Windows and Linux.
2. Qualify host/skill/service discovery using the synthetic provider in both arms. Separate authentication/transport failures from model-quality outcomes.
3. Freeze a **discovery pilot**: the six workloads above × two arms × one run = 12 trials, one fixed hosted model/configuration, alternating order, no targeted third arm. Keep the existing eight-minute/40-turn/200k reported-component thresholds for the continuity comparison; record overshoot and the limitations of that unit. They are monitored thresholds, not hard provider-call or invoice ceilings. Reserve allowance for both halves of a pair before issuing it, with no automatic replay or asymmetric budget top-up. Reaching a threshold is an outcome, not permission to enlarge it mid-cohort. No local Gemma.
4. If a concrete benefit appears, freeze a separate **held-out confirmation** with fresh variants before running it: two variants of each of the four challenge families plus both controls = ten pairs/20 trials. The eight challenge pairs are held out; reused public controls are controls, not unseen tasks. No tuning on those outputs; retained losses and setup failures remain visible. This stage needs a separately reviewed spending plan; this document does not launch it.
5. Report paired outcomes and uncertainty. A chosen example can illustrate an observed win but cannot establish superiority. For a formal superiority claim, predeclare the primary workload family/metric and require the paired confidence interval to exclude no benefit; otherwise describe results as promising, mixed or inconclusive. Cross-model generality requires a separately bounded second-model check after a signal, not silent model substitution.

Primary outcome: valid task completion under the fixed external resource allowance. For intentionally unresolved cases, a correctly bounded unresolved conclusion can be the required deliverable. Supplement with false acceptance/rejection, duplicate accepted computations, retained-work reuse, schema/parse/setup/capability failures, restart success, unknown-outcome recovery, tool/model calls, complete usage components and cost coverage, final-report contract violations, elapsed/active time, peak resource use and cleanup. Record actual graph/checker/reuse participation: an ALG-configured agent that solves a task directly without invoking those components does not demonstrate their benefit.

Do not use one blended score to hide a correctness loss behind speed. Report successful tasks and all admitted trials; count failed work in cost per verified outcome, and mark it undefined when no tasks pass. Compare data-service work units and reported model usage separately; if economics are modelled, show the explicit prices and break-even range instead of inventing invoice totals.

## First implementation slice and exit criteria

The next product slice is **task-contract admission + capability-compatible compact routing + original-criteria provenance**, after any reproduced mechanical repair. It is not recursive graphs, automatic strategy promotion, a shared meta-brain, a new datalake engine or OpenCode V2.

Exit when impossible writer/verification assignments are rejected before spending child calls, compatible plans preserve the accepted contract across resume, original criteria cannot be silently replaced by a research proposal, and both local host paths pass. Then add measured overhead/budget handling and qualify the comparative harness. Merge readiness still requires the PR's applicable local checks and an honest statement of unqualified offline-package/production-service boundaries; a hand-picked model win is not a release gate.
