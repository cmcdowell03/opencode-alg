# ALG V1 Design Index and Delivery Roadmap

Draft revised 12 November 2026. V1 means the OpenCode 1 host; document revisions use dates. No OpenCode 2 implementation is included.

## Purpose

Help an agent team work competently in its environment: resolve required procedures and facts before acting, retain verified work and unresolved questions through context loss, and adopt improvements only when evidence supports them.

This index owns sequencing within this draft set. The existing four owner contracts retain responsibility for context and decisions, knowledge and environment, execution and recovery, and coordination and improvement. This draft does not silently amend those published contracts or authorize implementation, production access or model spend.

## One first phase

**Phase 1a — Workspace readiness and deployment qualification.** Add one reviewed workspace requirements registry, using existing skill discovery, source approval, loading and context delivery. Seed it with actual Git, test, migration-preparation and investigation requirements. Advisory coverage comes first where action semantics cannot be enforced. Qualify the actual datalake-mcp tool/job guarantees and permitted data/model route before choosing service-specific additions. Independent local readiness work can proceed while remote access is unavailable; live acceptance stays open.

**Phase 1b — Durable bounded investigation.** Add one fixed investigation template to the existing graph machinery. Reuse server jobs and ALG persistence, adding only missing admissions, reconciliation, result reuse and compact context projections. Preserve approved procedures, ruled-out hypotheses, search coverage, budget and unknown submissions across compaction and restart. Include an engineer checkpoint before expensive discriminating work. The detailed Phase One plan owns limits, transitions and acceptance.

**Later V1 work.** Curated cases and useful candidates precede measured skill promotion. Selection and parameterization of existing templates precede free-form graph authoring and lifecycle-safe revisions. The requested artifact skill remains an optional extension. Recursive orchestrators, shared multi-user synchronization and new analytics engines are outside Phase One.

**Reliability follow-up to PR #14.** Before further graph complexity or automatic promotion, complete the [task-admission and Build-comparison plan](v1-reliability-and-build-comparison-plan.md): fix reproduced mechanics, reject incompatible deliverable/worker assignments, preserve original criteria, measure overhead, then evaluate durable recovery on a frozen fair cohort. These are planned V1 follow-ups; the earlier post-repair benchmark does not establish superiority.

The older umbrella's baseline/visibility and recovery work maps into Phase 1a/1b. Former A–E labels identify capability families, not another implementation order.

## Required platform acceptance

Phase One requires local Windows/PowerShell and Linux/Bash coverage. Provision a dedicated Ubuntu-24.04 WSL 2 environment during Phase 1a; run the shared recovery, installation and relocation acceptance in Phase 1b. The [Linux/Bash acceptance plan](alg-v1-linux-bash-acceptance-plan.md) owns setup and platform cases, including a single Bash deployment command for prepared connected/offline releases. It extends the existing versioned manager rather than adding another installer. WSL 2 is independent of OpenCode versioning; OpenCode 2 remains excluded. WSL success does not replace qualification on the actual native Linux deployment.

## Shared scorecard

Establish a baseline before setting improvement targets. Fix cohort, task definitions, verifier and observation window before comparison.

| Measure | Honest accounting |
| --- | --- |
| Verified completion | Verified outcomes divided by all admitted eligible tasks; retain failures, unresolved work and timeouts in the accounting |
| Explicit skill reminders | Observed user reminders per applicable task; an observable lower bound, not proof that unrecorded reminders never occurred |
| Avoidable repeated work | Duplicate accepted computations for compatible covered work identities; distinguish deliberate verification, changed inputs and authorized refresh |
| Cost per verified outcome | Include failed work, retries and checking; report known totals and missing-cost coverage separately; zero verified outcomes has no finite success-cost estimate |
| Investigation usefulness | Active and elapsed time to a supported conclusion or defensible next measurement; report unresolved/censored cases and relevant coverage |

Do not reward faster unsupported causal claims, silence about missing procedures or skipped verification. Local fixtures establish mechanics; target-host evidence establishes integration; curated retrospective/live evidence establishes usefulness in its stated scope.

## Document map

- [Core applicability and measured improvement](alg-v1-applicability-measured-improvement-design.md): ownership, requirements registry, applicability, evidence, future promotion and graph contracts.
- [Large data investigation profile](alg-v1-large-data-investigation-design.md): datalake-mcp boundary, imperfect map, analytical discipline and engineer review.
- [Phase One implementation plan](alg-v1-phase-one-investigation-plan.md): first deliverables, managed dispatch, crash recovery and acceptance.
- [Linux/Bash acceptance and WSL setup](alg-v1-linux-bash-acceptance-plan.md): required local platform matrix, environment setup and evidence.
- [Optional artifact skill extension](alg-v1-artifact-skill-extension.md): retained upstream skill, portability and verification requirements.
- [Claude review reconciliation](alg-v1-claude-review-reconciliation.md): agreements, qualifications and source provenance.
- [Graph evolution and adversarial review](v1-graph-evolution-adversarial-review.md): implemented opt-in citation-linked verdicts, bounded pending-node graph revisions and paired probe evaluation; stronger provenance and automatic promotion remain design.
- [Measured graph/review evaluation](v1-adversarial-evaluation.md): bounded Gemma/Luna comparisons, preserved failures, criterion ambiguity and exact local host/recovery evidence. Exploratory results do not authorize automatic promotion.
- [Reliability and comparison with native Build](v1-reliability-and-build-comparison-plan.md): first task/capability admission increment, mechanical qualification, overhead/budget design, fair workload matrix and held-out decision rules.

## Canonical documentation

This repository copy is the canonical implementation design. Earlier local artifacts remain historical drafts. This index owns the current phase order; the existing owner contracts retain semantic authority. The implementation PR tracks progress and local evidence without treating draft features as shipped.

## Implementation tracking

Candidate 0.5.6 is tracked in PR #14. The November 10 review withdrew the 80% estimate. Its confirmed ledger defects and missing local contracts now have implementations: assigned recipe orders, bounded result reads/cache, in-host job continuation, reviewed profile migration, native MCP mappings and workspace fact sources. Exact local acceptance and the remaining boundaries are recorded separately: the real datalake-mcp is unqualified, host waits are bounded rather than a daemon, and one successful local-model session after the duplicate-plan correction does not establish general long-session reliability. See [implementation status](v1-implementation-status.md), [V1 operator usage](v1-investigations.md) and [prepared deployment](deployment.md) for the implemented surfaces. The design remains broader than this first delivery: measured promotion, template improvement, recursive delegation, shared cross-user knowledge and OpenCode V2 are not activated by this PR. Local acceptance results are recorded against exact commits; draft design status does not count as a shipped or validated feature.
