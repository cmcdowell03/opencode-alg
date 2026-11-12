# V1 Graph Evolution and Adversarial Review (Design Draft)

Status: **V1 umbrella design with an opt-in 0.5.4 implementation increment, 11 November 2026**. The current implementation is described separately below; the roadmap adds no runtime behavior by itself. The existing applicability and measured-improvement design remains authoritative for evidence scope and promotion; the design index remains authoritative for roadmap order.

## Current implementation — 0.5.4 candidate

PR #14 implements an opt-in first increment. Models author graphs through `alg_plan.graph_json`; the existing finite DAG validator, ownership lease, attempt ledger and OpenCode permissions still govern execution. There is no recursive scheduler or automatic graph promotion. The fixed data-investigation graph is unchanged.

A checker opts in with `verification: {"version": 1, "mandate": "bounded question"}`. ALG assigns C1… criterion IDs and E1… evidence IDs, supplies a bounded mandate (2,000 characters), and requires one typed finding per criterion. Outcomes are `supported`, `disconfirmed`, `unsupported` and `inconclusive`, with included evidence IDs and a short rationale. Missing/omitted evidence cannot be cited; support and contradiction require a citation. The top-level verdict must agree with all findings: only all-supported can pass. Invalid bindings use fixed diagnostics on retry. A dry run cannot claim verified success.

Before the child starts, its attempt persists the criterion digest and evidence source/attempt/digest commitments. The existing content-addressed attempt details and output artifacts preserve these through projection, compaction and reload. Evidence remains capped at eight entries, 4 KiB per value and 16 KiB total. A citation demonstrates linkage to supplied bytes, **not truth, freshness, independence, or an independently executed test**. Model summaries and graph literals retain that limitation. The final checker must assess source adequacy; semantic verification cannot be guaranteed by JSON validation. A general admitted-result provenance/freshness resolver remains future work. Legacy boolean checkers retain their original contract and do not acquire evidence-qualified status.

`alg_plan` also accepts `revise_run_id`, `expected_graph_sha256`, `revision_reason` and `graph_json` for the same owner's planning/blocked run. Only unattempted pending nodes can change. Existing checker definitions and verifier edges, attempted definitions/results, objective, criteria, execution directory, global attempts and caps stay fixed. The host rejects stale digests, active/terminal/exhausted runs, managed investigation revisions, new feedback loops and scope/budget expansion. Accepted revisions store a bounded receipt chain (maximum 16) and immutable canonical graph snapshots in the existing run artifacts. `alg_status` supplies the current digest; use it after compaction instead of creating a replacement run. This supports adding a bounded probe before an unstarted synthesis when its existing verifier edges remain valid. It does not invalidate completed work or reopen completed runs.

Use an ordinary researcher node for a falsification probe before synthesis, and retain a separate final checker. Set finite local attempts and a root cap that includes the probe. OpenCode controls tools and per-child steps; ALG counts node attempts, not every internal provider/tool token. No automatic probe selection or extra budget is granted by this feature. For managed datalake investigations, continue using admitted work orders and cached result pages; this increment does not change that graph or permit a second remote search path.

The paired evaluation in `scripts/adversarial-evaluation.ts` compares an ordinary review memo with a targeted falsification memo before the **same** evidence-linked final checker. Both arms receive the same frozen synthetic observations, two calls and output limits; order is alternated. The checker is blinded to the arm label. This is an exploratory component evaluation, separate from full DAG/headless acceptance. It measures correctness, unresolved outcomes, false acceptance/rejection, output-contract failures, reported usage and elapsed time. Failed calls remain in the results. The existing checker already uses adversarial wording, so this is not a neutral-versus-adversarial-checker comparison. No superiority or promotion is assumed.

The broader contracts below remain design targets where they exceed this bounded increment. See the implementation status and paired-evaluation receipt for exact tested scope and limitations. New fields require the 0.5.4 reader; do not roll older readers over newly written state.

### Evaluation-target boundary

The [bounded model comparison](v1-adversarial-evaluation.md) exposed a distinction this contract cannot settle through citation checks: a child can verify a review memo's method while passing an original claim that the memo contradicts. Write each criterion as a proposition about the original claim; express required methods separately. A probe memo supplies leads, never a replacement claim or acceptance criterion. The recorded criterion/evidence basis protects identity and consistency of references, not semantic interpretation. A later V1 extension should give the original claim its own host-pinned identity and separate it structurally from advisory memos, then qualify that interface on a fresh frozen cohort. This is a design follow-up, not a retroactive repair or promotion of the current evaluation result.

## Minimal roadmap

### Using the implemented increment

An explicit custom graph can use `research -> probe -> synthesis -> check`, or run research/probe in parallel from the same pinned observations. The probe should answer one falsifiable question, such as whether the particle-rate difference survives matching by route/product/time. Count it in `max_global_attempts`; set `loop.max_attempts` for every node. The final checker is separate, opts into `verification`, and wires original observations plus selected probe/synthesis artifacts through `evidence_*`. A model report alone is not an independently measured observation. Supply bounded result pages from an already admitted query; do not rerun the lake search merely to create a new graph.

For example, the checker portion of a caller-authored graph is:

```json
{
  "id": "check",
  "agent": "checker",
  "depends_on": ["synthesis"],
  "isolated_check": true,
  "verification": {
    "version": 1,
    "mandate": "Check the matched-cohort explanation and competing measurement/join explanations. Missing coverage is uncertainty, not a defect finding."
  },
  "inputs": {
    "claimed": "synthesis",
    "evidence_probe": "probe",
    "evidence_observations": "research.evidence"
  },
  "loop": {"max_attempts": 1, "gate": "schema"}
}
```

`research.evidence` is a source report; the checker must inspect the cited observations within host permissions. The contract prevents invented E IDs, but cannot convert that report into verified factory data. If no adequate observation is accessible, return unsupported/inconclusive and do not pass.

After `alg_status` returns the digest, an owning orchestrator can submit a revision through `alg_plan` with only `revise_run_id`, `expected_graph_sha256`, `revision_reason` and the complete `graph_json` (plus display/root-authorization options where applicable). Revisions cannot edit the checker above; plan its mandatory coverage before execution. Add a probe by extending the inputs/dependencies of an unattempted synthesis while retaining its existing dependencies and verifier. If there is no unused allowance in the original cap, report that constraint rather than creating a replacement plan to evade it. Use `alg_artifact` to read `graph-<sha256>.json` from the run's artifacts directory when historical graph bytes are needed.

Evidence and disposition remain attempt data, not conversational memory. After compaction, inspect `alg_status` and selected artifacts for the existing run. A model cannot infer approval, refresh a source version, or recover spent budget by rewriting a summary. General completed-work invalidation, automatic template selection and measured promotion are deliberately not implemented by this increment.

### 1. Evidence-bound checker result (linkage implemented; stronger provenance remains design)

In a separate compatible contract change, each finding should identify the criterion/claim, outcome (`supported`, `disconfirmed`, `unsupported`, or `inconclusive`), bounded evidence references, and a concise rationale. A reference must resolve to an immutable run artifact, test result, or admitted MCP result with source/version and scope metadata; bare model prose is not evidence. Preserve the existing top-level gate verdict for compatibility, but derive it from criterion results and configured hard criteria.

“Unsupported” means the admissible evidence does not establish the claim; it is not evidence against the claim. “Disconfirmed” requires a cited observation that contradicts a stated prediction under adequate declared coverage. Missing, inaccessible, stale, conflicting, or dependent evidence stays unsupported/inconclusive. Repeated summaries of the same upstream source do not become independent evidence.

The checker receives the bounded evidence inputs already wired to its node and, in a later design increment, a manifest of what was available and actually inspected. Any fetch remains within host/operator permissions; ALG cannot grant permissions. No transcript dump, hidden reasoning, unrestricted search, or implicit permission expansion. If evidence cannot be fetched or bound, the verdict is unresolved/rejected for missing support, not passed by confidence or score.

Add a distinct, bounded falsification-mandate field to the checker prompt contract. The executor must pass it explicitly and enforce its byte/size limits; `description` is not a substitute because the current checker prompt does not include it. The richer output must bind each disposition to its evidence references and distinguish evidence insufficiency from contradiction.

Keep child output small: the host assigns criterion/evidence identifiers and the child selects those identifiers with a short finding, rather than re-emitting source metadata or large artifacts. Reuse existing schema diagnostics and informed retry handling. Version the output/reader contract and test old run recovery; a legacy boolean verdict must not silently acquire evidence-qualified status. A richer schema that substantially increases invalid-output failures has not improved the verifier. Measure contract failure rate and verified outcomes together across the same model-agnostic fixtures.

### 2. Model graph proposals, then freeze before execution (bounded validation implemented; full applicability receipt remains design)

Allow a model to propose a declarative graph using the existing graph schema and node types. Treat the proposal as untrusted data: validate structure, operation/resource scope, skill and tool requirements, node/output limits, dependency references, checker coverage, and cumulative budgets before acceptance. Applicability checks run at the existing plan/delegation boundaries. A proposal cannot grant permissions, redefine mandatory procedures, set its own trusted identity, or select its own approver.

Persist the accepted graph as an immutable run revision before the first executable node. Bind the canonical graph digest, parent/proposal digest, authoring model/configuration, criteria, applicability snapshot, policy/skill closure references, and validation receipt. Execution, resume, and checker feedback use that frozen revision. A proposal or checker cannot silently patch it.

### 3. Explicit lifecycle-safe revisions (pending-node subset implemented)

A revision is a new immutable child revision with a reason, changed-node/dependency diff, invalidation analysis, and approval receipt where policy requires one. Preserve objective, hard criteria, owner, resource/permission scope, prior attempts, results, and cumulative elapsed/token/tool/job budgets. A revision may not replenish exhausted budget or reopen a completed run. Store checkpoints as references to exact graph revision, node inputs/outputs, artifact digests, source versions, and verifier versions.

Retain completed work only when its declared inputs, environment/code state, skill closures, evidence freshness, and verifier contract remain compatible. Otherwise mark it invalidated and reserve any recomputation from the same root remainder. For remote work, persist canonical request identity, admission/reservation, and a durable dispatch intent before any side effect. Record outcome only after observing or reconciling the service response; reconcile unknown submissions before retry. Cache/reuse only compatible results. A deliberately repeated independent probe is allowed only when declared in advance, separately budgeted, and linked to the prior result; it does not evade duplicate-work controls.

### 4. Bounded adversarial review and later evaluation (explicit probes and exploratory comparison; automatic selection remains design)

Represent adversarial probes as ordinary, scoped research DAG nodes **before synthesis**, with narrow work orders, independent evidence inputs, explicit falsification questions, allowed tools/resources, stop rules, and reserved root budget. They submit bounded probe findings into synthesis. Probe observations are measurement evidence, not checker verdicts. They are distinct from the final checker, which separately reviews the synthesized claims and evidence against fixed criteria. Keep probes non-recursive: they cannot spawn reviewers, alter graph/criteria, widen scope, approve their own proposal, or authorize their own findings. Use the existing executor, persistence, feedback routing, and job reconciliation; no second scheduler or new store hierarchy.

This is a design direction, not a promise of an automatic adversary runtime in the current PR. Any future probe uses ordinary DAG execution and the root budget; it adds no recursive scheduler.

For a semiconductor defect hunt, a bounded candidate could collect process/equipment/metrology evidence, then ask one adversarial research node whether the apparent equipment effect survives matched product/route/time controls. A second, independently justified probe could test whether sampling, timestamp alignment or a join error explains the same signal. Each probe starts from existing result references and an admitted work order; it requests another expensive query only when the current evidence cannot answer its specific falsification question. Reconciliation retains both supporting and contrary observations. The final checker inspects the stated criteria, source coverage and evidence chain; a still-plausible alternative remains an explicit uncertainty, not a forced consensus or an invented defect. This example does not change the fixed investigation template shipped in this PR.

Start with one additional probe for one material uncertainty and a declared share of the root budget. Add another only when it tests a different failure mode and policy admits its cost. Stop when the question is answered, evidence access is insufficient, or the allowance is exhausted. Host/accounting enforcement of these proposed probe allowances must be implemented before automatic use; prompt instructions alone are insufficient.

Use a bounded number of independent probes selected for different failure modes (for example, recompute a decisive result from pinned inputs; search for a counterexample to one hard claim). Independence means separate evidence path or method where possible, not merely another model call or majority vote. Correlated models, shared tools, common-source dependence, and blind spots must be disclosed. A disagreement remains visible and unresolved until evidence or an authorized human resolves it. Neither agreement nor quorum guarantees correctness.

Only after mechanics are qualified should graph candidates enter the existing measured-improvement path: fixed, independently curated tasks; incumbent/candidate paired under the same environment, criteria, tools and total root budget; protected regressions and failures retained; planner, workers, retries, adversarial probes, and verification all costed. Candidate eligibility is scoped evidence for review, not automatic publication, activation, or active-run revision. Reuse the existing skill/template evaluation and promotion contracts; do not replace experience, skill, template, or investigation stores.

## Ownership boundary

The [V1 investigation state-ownership contract](v1-investigations.md#state-ownership) documents current persistence and recovery responsibilities. This table describes the graph/checker boundary, including the proposed revision lifecycle.

| State | Owner | Boundary |
|---|---|---|
| Graph admission, frozen revisions, run identity, reservations and cumulative budgets | ALG control plane | Authoritative bounded coordination and lifecycle; models propose, host/operator policy admits. ALG cannot grant permissions. |
| Approvals and tool/resource permissions | OpenCode host and operator policy | ALG checks and records applicable scope; it cannot grant or expand authority |
| Conversation and visible child-session cards | OpenCode host transcript | Interaction/projection; not the authoritative graph, evidence ledger, or budget |
| Bulk datasets, remote query execution and long-running job state/results | MCP service | ALG stores bounded request/job identity, status and immutable result references; do not copy bulk data into graph state |
| Human-readable summaries, compact status and generated reports | Derived view | Rebuild from authoritative records; never treat prose as a separate source of truth |

## Acceptance criteria for future implementation

These are proposed measurable gates, not current test results. Keep deterministic contract tests local and model-agnostic; separately label any provider trial and its configuration. No test here is authorized by this draft.

- **Evidence binding:** 100% of checker findings resolve to an admitted artifact and criterion; mutated, missing, stale, out-of-scope, or inaccessible references fail closed. A pass with zero required evidence is rejected. `unsupported` never becomes `disconfirmed`; unsupported/inconclusive hard criteria never produce a supported pass.
- **Independent falsification:** fixtures include a supported claim, a true counterexample, missing evidence, conflicting evidence, duplicated/dependent sources, and a misleading summary. The checker reports the expected distinctions and cites exact references. No majority-vote or confidence-only pass path exists.
- **Proposal freeze:** malformed, oversized, cyclic, permission-widening, checker-self-approving, or budget-exceeding proposals are rejected before side effects. The accepted graph digest is stable across execution/resume; active graph bytes never change through model output or feedback.
- **Revision and budget conservation:** every revision has a parent and complete diff/provenance; criteria, scope, history, and remaining root budget are conserved. Exhausted/completed runs cannot regain capacity. Invalidated descendants rerun only from remaining budget.
- **No duplicate remote work:** crash/timeout at every admission/dispatch/result boundary reconciles the same request/job before any resend; compatible completed results are reused, while an explicitly budgeted independent probe is visible and counted.
- **Bounded adversary:** maximum reviewer count, concurrency, tool set, prompt/evidence bytes, retries, and spend are enforced by the host; no recursive fanout or permission change is possible. Every call/probe is included in root accounting. Disagreement and evidence gaps remain visible.
- **Measured improvement:** paired candidate/incumbent evaluation uses the same frozen cohort and total budget, reports verified outcomes, regressions, unresolved/censored cases, elapsed time and complete known cost; promotion eligibility cannot rewrite active runs and cannot authorize publication by itself.

## Constraints and sequencing

Keep V1 model/provider agnostic and on OpenCode 1. Reuse the current DAG executor, checker feedback path, work-order/checkpoint contracts, artifact references, MCP job ledger, applicability checks, and measured-promotion plans. Do not add recursive orchestrators, a second scheduler, a general-purpose graph framework, or replacement stores. Implementation sequencing should start with evidence-bound checker output and exact local acceptance, then proposal validation/freeze, then lifecycle-safe revisions, then prospective adversarial and paired-improvement evaluation. Each later stage depends on the previous stage's evidence and the existing execution/recovery contract.
