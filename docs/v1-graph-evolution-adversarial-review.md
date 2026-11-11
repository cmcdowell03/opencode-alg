# V1 Graph Evolution and Adversarial Review (Design Draft)

Status: **V1 design proposal, 11 November 2026**. The current implementation is described separately below; the roadmap adds no runtime behavior by itself. The existing applicability and measured-improvement design remains authoritative for evidence scope and promotion; the design index remains authoritative for roadmap order.

## Current implementation

At checkout `fa5ffa6` (PR #14 draft), `alg_plan` accepts either a built-in template or caller-supplied `graph_json`; both pass `GraphDefSchema` and use the same DAG executor. Graphs are finite (1–64 nodes, bounded dependencies, attempts, concurrency and serialized size). The run persists its graph and attempt history. The fixed investigation graph is protected from customization.

A checker node can be marked `isolated_check`; `feedback_to` can route its schema-valid rejection to one direct dependency. That target and its descendants are reset only within remaining local and global attempt limits. The checker is a fresh child. ALG explicitly sends criteria, claimed output, and prior failures, not the worker transcript. The PR follow-up adds explicit checker evidence inputs through `evidence` and `evidence_*` ports: at most 8 entries, 16 KiB serialized evidence total, and 4 KiB per included value. The compiled investigation policy also preserves its existing `reconciliation` input without changing the stored graph. Entries identify source, digest, and whether the value was included, omitted, or unavailable. These bounds and hashes identify supplied JSON; they do not establish truth or independent verification. Existing tool and project context can still be available to the child.

The current `CheckOut` schema requires `passed`, `failures`, and integer `score`, with optional `notes`. It enforces verdict/score consistency and failure-list consistency. Rich evidence-bound checker output remains **DESIGN ONLY**: the schema does not require claim-linked references, identify what the checker independently inspected, or distinguish “not supported by supplied evidence” from “evidence contradicts the claim.” Therefore a well-formed checker pass can finish a gate without a persisted, claim-linked evidence basis. A checker score is not a probability or proof. Also, the checker prompt currently ignores the node `description`; a future role-specific falsification mandate needs an explicit bounded prompt field that the checker prompt consumes, not an instruction placed only in that description.

The executor does not let a model edit the active graph during execution. Custom graph authoring already exists through `graph_json`; automated graph selection, measured promotion, and lifecycle-safe revisions are later V1 work. The measured-improvement design already requires comparing graph patterns on fixed tasks and budgets, counting planning/checking/retries, and never letting promotion rewrite active runs. Measured skill promotion and template improvement are also design work, not activated features. Do not infer automation or revision capability from custom-graph input or checker feedback.

## Minimal roadmap

### 1. Evidence-bound checker result (first; DESIGN ONLY)

In a separate compatible contract change, each finding should identify the criterion/claim, outcome (`supported`, `disconfirmed`, `unsupported`, or `inconclusive`), bounded evidence references, and a concise rationale. A reference must resolve to an immutable run artifact, test result, or admitted MCP result with source/version and scope metadata; bare model prose is not evidence. Preserve the existing top-level gate verdict for compatibility, but derive it from criterion results and configured hard criteria.

“Unsupported” means the admissible evidence does not establish the claim; it is not evidence against the claim. “Disconfirmed” requires a cited observation that contradicts a stated prediction under adequate declared coverage. Missing, inaccessible, stale, conflicting, or dependent evidence stays unsupported/inconclusive. Repeated summaries of the same upstream source do not become independent evidence.

The checker receives the bounded evidence inputs already wired to its node and, in a later design increment, a manifest of what was available and actually inspected. Any fetch remains within host/operator permissions; ALG cannot grant permissions. No transcript dump, hidden reasoning, unrestricted search, or implicit permission expansion. If evidence cannot be fetched or bound, the verdict is unresolved/rejected for missing support, not passed by confidence or score.

Add a distinct, bounded falsification-mandate field to the checker prompt contract. The executor must pass it explicitly and enforce its byte/size limits; `description` is not a substitute because the current checker prompt does not include it. The richer output must bind each disposition to its evidence references and distinguish evidence insufficiency from contradiction.

### 2. Model graph proposals, then freeze before execution (DESIGN ONLY)

Allow a model to propose a declarative graph using the existing graph schema and node types. Treat the proposal as untrusted data: validate structure, operation/resource scope, skill and tool requirements, node/output limits, dependency references, checker coverage, and cumulative budgets before acceptance. Applicability checks run at the existing plan/delegation boundaries. A proposal cannot grant permissions, redefine mandatory procedures, set its own trusted identity, or select its own approver.

Persist the accepted graph as an immutable run revision before the first executable node. Bind the canonical graph digest, parent/proposal digest, authoring model/configuration, criteria, applicability snapshot, policy/skill closure references, and validation receipt. Execution, resume, and checker feedback use that frozen revision. A proposal or checker cannot silently patch it.

### 3. Explicit lifecycle-safe revisions (DESIGN ONLY; only after recovery contract support)

A revision is a new immutable child revision with a reason, changed-node/dependency diff, invalidation analysis, and approval receipt where policy requires one. Preserve objective, hard criteria, owner, resource/permission scope, prior attempts, results, and cumulative elapsed/token/tool/job budgets. A revision may not replenish exhausted budget or reopen a completed run. Store checkpoints as references to exact graph revision, node inputs/outputs, artifact digests, source versions, and verifier versions.

Retain completed work only when its declared inputs, environment/code state, skill closures, evidence freshness, and verifier contract remain compatible. Otherwise mark it invalidated and reserve any recomputation from the same root remainder. For remote work, persist canonical request identity, admission/reservation, and a durable dispatch intent before any side effect. Record outcome only after observing or reconciling the service response; reconcile unknown submissions before retry. Cache/reuse only compatible results. A deliberately repeated independent probe is allowed only when declared in advance, separately budgeted, and linked to the prior result; it does not evade duplicate-work controls.

### 4. Bounded adversarial review and later evaluation (DESIGN ONLY)

Represent adversarial probes as ordinary, scoped research DAG nodes **before synthesis**, with narrow work orders, independent evidence inputs, explicit falsification questions, allowed tools/resources, stop rules, and reserved root budget. They submit bounded probe findings into synthesis. Probe observations are measurement evidence, not checker verdicts. They are distinct from the final checker, which separately reviews the synthesized claims and evidence against fixed criteria. Keep probes non-recursive: they cannot spawn reviewers, alter graph/criteria, widen scope, approve their own proposal, or authorize their own findings. Use the existing executor, persistence, feedback routing, and job reconciliation; no second scheduler or new store hierarchy.

This is a design direction, not a promise of an automatic adversary runtime in the current PR. Any future probe uses ordinary DAG execution and the root budget; it adds no recursive scheduler.

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
