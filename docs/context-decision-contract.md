# Context and decisions contract

Status: Draft component contract, 2026-10-17. Part of
[durable operational context and execution](skill-knowledge-graph-design.md).
These are implementation requirements, not currently supported configuration.

This contract owns skill applicability, task-specific working sets, decision
dependencies, context allocation and request-bound delivery. It consumes work and
environment state; it does not infer permissions or schedule workers.

Delivery targets V1 under the umbrella's V1 scope. Future V2 integration is design
compatibility only, not a dependency or runtime implementation in this increment.

## Skill eligibility and current context

Keep durable eligibility separate from delivery state. A flat "loaded" Boolean
cannot express compaction, phase changes, and multiple concurrent child sessions.

Durable eligibility states are `candidate`, `relevant`, `required`, `dormant`,
`stale`, and `revoked`. Store the reason and exact task/environment scope of each
transition. Completing a phase can make a skill dormant without losing its history.
A task or environment change invalidates dependent bindings rather than carrying
them forward by name.

Per-request delivery records use `prepared`, `emitted`, `host_confirmed`, or
`unknown`, independently of eligibility. Bind a receipt to session, task epoch,
checkpoint revision, host context generation, request ID, selected skill revisions,
complete dependency closure, and context hash. `host_confirmed` is available only
when an instrumented host actually confirms the final request; plugin emission
alone is weaker evidence. Neither proves understanding or compliance.

When V1 exposes only a plugin-hook invocation, label its generated identifier as
plugin-local correlation. Do not fabricate a host request ID or context generation.
Record unavailable host evidence explicitly. Repeated hooks replace only the
context owned by ALG, preserve foreign contributions, and cannot settle an older
request as proof of delivery for a newer one. Interrupted publication or receipt
persistence remains prepared/unknown until supported evidence resolves it.

After compaction/restart, previous delivery receipts cannot authorize reuse in a
new request. Reconstruct required procedures from durable bindings and reverify
sources. A successful tool event naming a skill is weaker than a receipt of exact
bytes; retain that distinction when observing legacy loads.

## Selection before decisions

Run selection at task start/change, before planning or delegation, after a resource
or failure-signature change, and before each covered consequential operation. A
short "continue" prompt uses the durable task and next-step state, not lexical
matching against that word. Routine unchanged turns reuse revision-keyed results.

The router accepts a bounded structured intent: task phase, operation, resource
references, environment identity, role, and observed failure codes. Intent inferred
from prose remains a proposal. Resolve ambiguous aliases visibly; no guessing that
two similarly named databases are the same resource. Persist commitments only at
explicit plan/decision boundaries, not by extracting arbitrary conversation text
as authoritative instructions.

Selection order is:

1. Validate scope, source trust, revocation, and current task/environment bindings.
2. Resolve reviewed exact resource/operation requirements and explicit user pins.
3. Expand complete declared prerequisites and report conflicts or missing sources.
4. Discover additional candidates through typed resource paths and lexical lookup.
5. Rank optional candidates deterministically, with match paths and exclusion reasons.
6. Assemble the instruction/evidence pack and its delivery receipt under the budget.

A reviewed applicability manifest may auto-select a complete procedure from an
already trusted source when exact predicates match. A fuzzy match or model-created
edge only proposes a candidate. It cannot write a mandatory rule, grant trust, or
change a reviewed pin. Expensive or uncertain selection may ask for clarification;
it must not create a new skill just because discovery was incomplete.

Use strict declarative predicates: resource IDs/classes, operation IDs, environment
IDs, known version constraints, and fixed failure codes. Do not execute manifest
scripts, evaluate arbitrary expressions, or depend on unbounded regular expressions.
An `exclude` match removes applicability only within the policy that declares it;
it cannot override a separate higher-priority required procedure.

### Routing contract

Extend the reviewed skill manifest with a stable identity and bounded declarative
rules. Each rule identifies its resource IDs or classes, operation IDs, applicable
task phases/roles, environment constraints, prerequisite revisions, and whether it
recommends or requires the procedure. It references an explicit review/policy
revision. Optional alias mappings are reviewed records, not fuzzy identity merges.

Required matches may traverse only reviewed, allowlisted resource relations whose
conditions apply to the current environment. An inferred graph connection is useful
for discovery but cannot establish a required procedure. Exact-source repinning
still requires review when the instruction revision changes.

The router returns a typed result containing `required`, `recommended`, `excluded`,
`unresolved`, match paths, source revision vector, and coverage. Each selected item
names an exact skill revision and dependency closure. Result status is `ready`,
`needs_skill`, `needs_context`, `conflict`, or `coverage_unknown`. Mandatory conflicts
cannot be resolved by a ranking score. Optional candidates sort by explicit match
tier, path length, and stable ID so identical inputs produce identical selections.

Resolve structured intent at an explicit task/plan boundary. If the model must first
identify the operation or resource from prose, that is a provisional classification;
perform routing and a fresh model request before accepting the consequential plan
or covered tool dispatch. An unrecognized resource is a visible coverage gap, not
evidence that no skill applies. Resource inference must never initiate network probes.

For example, `dashboard -> reads-from -> dataset` can select an exact timezone and
join-grain requirement for an aggregate operation. An API relation can add a reviewed
read-only access procedure. Explain both selection paths. A graph neighbor about
deploying the API stays dormant during that read-only investigation.

## Portable applicability and approval

Keep identity, dependencies and declarative applicability alongside the skill. The
preferred authoring form is a namespaced `alg` block in `SKILL.md` frontmatter.
If a supported host rejects unknown frontmatter, use an adjacent
`alg-skill.json` sidecar bound to the exact skill digest. Both compile into one
canonical manifest; conflicting duplicate declarations fail validation. Check
supported V1 compatibility before choosing the packaged form. V2 packaging checks
are deferred and must not hold up the V1 form.

Example authoring shape; field names are proposed, not current host configuration:

```yaml
name: orders-dataset-validation
description: Validate grain and timestamps before aggregating order data.
alg:
  schema: 1
  id: skill:orders-dataset-validation
  prerequisites:
    - id: skill:read-only-query
      revision: "<exact-digest>"
  applicability:
    - id: rule:orders-aggregate
      operation: dataset.aggregate
      resources: [dataset:orders]
      environments: [staging]
      roles: [analyst]
      strength: required
    - id: rule:orders-path-candidate
      paths: ["analytics/orders/**"]
      tools: ["read", "grep"]
      strength: recommended
```

The manifest does not contain its own approval. A separate review receipt binds
its digest and scope under the
[approval contract](knowledge-environment-contract.md#review-and-approval-records).
A skill file from an untrusted source remains untrusted even if its frontmatter
says required.

Add bounded project-relative path globs, exact structured tool/operation names and
schema-owned failure codes as early routing signals. An allowlisted parser may
classify a known command dialect into a safe operation ID; never evaluate a command,
store its secrets, or infer permissions from a basename such as `python`.
Globs need normalized roots, platform-aware casing/separator rules, bounded match
cost and traversal rejection. They are authored policy, not zero-curation truth.
An incident fingerprint suggests a search candidate, not a mandatory procedure or
proof that a previous fix applies.

Example router result:

```json
{
  "status": "ready",
  "required": [{"id": "skill:orders-dataset-validation", "revision": "<digest>",
    "rule": "rule:orders-aggregate", "approvalRef": "approval:rule-17@digest"}],
  "recommended": [],
  "excluded": [],
  "unresolved": [],
  "sourceVector": ["dataset:orders@v4", "environment:staging@r8"],
  "coverage": {"completeForDeclaredScope": true},
  "closureRef": "artifact:instruction-closure@digest"
}
```

An already-authoritative requirement with a missing source or invalid approval
produces a non-ready result for its affected operation. An unapproved proposal
cannot declare itself required and block unrelated work. Inferred intent can select
advisory candidates, but cannot expand the approved mandatory scope. Existing valid
approved bindings can be restored before the new approval UI or router is built;
the knowledge contract defines how their trust and provenance are checked.

## Context budget and recovery

Retain one shared allocator, but make mandatory-content precedence explicit.
Current per-part weights and carry-forward are baseline behavior, not hard quotas
for required instructions. The allocator follows the order below within the actual
request-capacity estimate; optional shares cannot starve mandatory content.

Do not include every historically bound skill. Resolve phase-specific requirements
first and keep irrelevant bindings dormant. Optional evidence can be omitted with
visible reasons; required instructions cannot be clipped or replaced by summaries.
An oversized mandatory closure returns `needs_context` before the dependent
action. Recovery is a smaller task, host-supported compaction plus remeasurement,
or separately authored complete modules with explicit prerequisites. Compaction
does not excuse missing instructions and does not guarantee that the closure fits.

Rebuild ALG's owned pack instead of repeatedly appending the same skill text. Do
not remove another plugin's context. Deduplicate shared prerequisites by exact
artifact identity while retaining their inclusion reasons. No full graph scan or
full instruction-catalog read should be required on every model request.

Write bindings, decisions, applications, and event cursors at their own successful
boundaries. Compaction requests a snapshot, but correctness does not depend on its
summary preserving a paragraph. Restart verifies durable heads and restores the
same eligible revisions; changed/missing sources remain explicit blockers.

Workers receive the instruction closure for their assigned operation, not all of
the parent's historical skills. Authorized run updates share the existing context
allowance, not an extra unbounded channel. Checkers receive independently selected
checking procedures and task constraints, without worker private reasoning or
resolutions being promoted to ground truth. Scope and revision checks apply to
each child and to every shared update.

### Allocation precedence and capacity

1. Reserve host/system policy, tool schemas, estimated conversation, reply room
   and accounting uncertainty when determining the usable request capacity.
2. Within ALG's configured total allowance, reserve the essential work pointer,
   current constraints/authority references, blockers and next action.
3. Allocate complete required procedures and prerequisites plus evidence explicitly
   required by the planned verification or decision.
4. Allocate optional evidence, catalog suggestions and other graph neighbors with
   the remaining weighted shares. Deduplicate by exact artifact digest.

Distinguish the normal allocation target from the operator-approved hard ceiling.
The current 5% default is configurable, not an architectural maximum. For the
first V1 phase, retain 5% as the normal target, capped by any lower operator limit,
and use the existing `perCall` setting as the hard ceiling (both default to 5%).
The operator may explicitly raise `perCall` to permit complete mandatory content
above that target. No new adaptive tuning service or automatic ceiling change is
required. Compaction assembly obeys its separately configured `compaction` cap;
a higher per-call allowance does not silently raise the compaction allowance.

The effective ceiling is the lesser of the configured context-window share and,
when known, the configured share of safely remaining capacity. Account for policy,
tools, conversation, reply room and uncertainty before estimating that remainder;
do not deduct a reserve twice. The default `ofAvailable` of 0.5 is another limit,
not permission to take half the free window regardless of `perCall`.

After removing optional material, the minimal orientation plus complete required
procedure/evidence closure may exceed the normal target only within that explicitly
configured ceiling. Optional material fills remaining room up to the normal target;
it does not consume a larger mandatory-content allowance simply because one was
authorized. Record target, configured/effective ceilings, mandatory size, omissions
and the limiting reason in context status. A model request cannot raise the ceiling.

If the mandatory closure exceeds the effective ceiling, return `needs_context` for
the dependent operation. Use smaller tasks, separately authored complete modules,
or compaction followed by remeasurement; never loop compaction when the unchanged
closure still exceeds the hard cap. An operator can choose a larger cap explicitly.
A byte floor is an orientation target, never permission to exceed safe request
capacity. Report insufficient capacity through status/tool metadata rather than
forcing the floor into an already full prompt.

Bytes-per-token is an estimate, not tokenization proof. Unknown/stale usage carries
an explicit confidence/gap and conservative reserve. Provider-specific counting
belongs in capability-tested adapters, not model-name branches in policy.

Enforce the ceiling against the final serialized ALG contribution, including
separators, orientation, recovery text and fallback diagnostics, not merely the
sum of individual section allowances. Check this after assembly and before
publication. Do not clip a complete required procedure to make the check pass.
If even a diagnostic cannot fit, surface the gap through status/tool metadata;
zero capacity must not trigger an unbudgeted fallback injection. Foreign context
is not ALG-owned text, but its measured usage still reduces safe request capacity.

### Context pack and delivery evidence

A request contains one ALG-owned pack, ordered deterministically:

```text
Work
  objective and criteria; current task; next action; unresolved blockers
Constraints
  environment/principal scope; current restrictions; required confirmation
Required procedures
  complete exact-revision instructions and declared prerequisites
Required evidence
  bounded verification inputs and exact source expansion handles
Optional context
  relevant observations, hypotheses and recommended procedure handles
```

The durable sidecar receipt binds request ID, context generation, membership epoch,
selected revisions, source vector, exact pack digest, omissions and delivery state.
Per-request IDs, heartbeat timestamps and receipt bookkeeping stay out of prompt
text unless the task genuinely needs them. Stable record/source handles remain
in the pack. Equivalent knowledge should serialize byte-identically; changed
permissions, sources or blockers must update it even if that invalidates a cache.
No cache savings are claimed without provider-reported measurements.

V2 native skill attachment, typed skill messages, session instruction entries and
final-request hooks are future adapter candidates, not current implementation
work or exemptions from this contract. When V2 work is separately authorized,
probe exact bytes, revision identity, ordering, permissions, revocation after
compaction and coverage before issuing `host_confirmed`. A skill message alone
does not prove the final model request retained every required byte. Keep the
V1 primary delivery path and mark weaker delivery evidence honestly.

## Late discovery and decision review

When a new skill, changed prerequisite, or conflicting fact becomes relevant:

1. Store the new assertion with provenance; do not rewrite the earlier decision.
2. Reverse-query decisions/applications that depend on the changed identity or
   affected resource/operation, including decisions that never linked the skill.
3. Traverse dependent decisions within the impact-query budget and emit a review
   set with paths explaining each match. Relevance alone means "review needed",
   not "the decision is wrong".
4. Mark affected proposed work for re-evaluation before the next covered action.
   Unaffected branches retain their completed status.
5. Record a reaffirmed, revised, or withdrawn decision with evidence and a
   supersession link. Preserve contradictory evidence and previous outcomes.

For work already executed, assess consequences first; never automatically roll
back, rerun a costly query, or modify production. Unknown dependencies are coverage
gaps, not proof of no impact. A truncated impact query cannot report "all clear".
An uncommitted free-form thought cannot be retroactively recovered as a decision.

Deduplicate reviews by changed assertion revision and decision revision. Bound
automatic review attempts and report a persistent conflict rather than repeatedly
reopening the same work. Record expiry and invalidation conditions for resolutions;
"already solved" must not suppress a needed new test after the environment changes.

Dependency traversal and freshness checks are owned by the
[knowledge contract](knowledge-environment-contract.md#incremental-invalidation).
Changes to execution plans go through the execution contract; reviewing a decision
never silently replays an effect.

## Action coverage and host integration

Pre-model selection is the primary mechanism: instructions must be available
before choosing a plan. A before-tool guard is the final check, not a substitute
for prior context. If required instructions are absent, return `needs_skill` and
require a fresh model request/plan before executing; do not inject text and then
execute the previously chosen arguments unchanged.

The core accepts a host capability report covering final-context visibility,
compaction/generation events, request correlation, pre-tool interception, and
parent/child identity. Adapters must test actual behavior, not infer guarantees
from SDK declarations. V1 and V2 adapters use the same domain rules; this proposal
does not extend the package's declared supported OpenCode range.

Begin enforcement with ALG-owned operations. A guard binds the required revision
set and context receipt to the exact operation/resource/environment. Check current
revocation and source revisions immediately before action. A mismatch returns a
typed conflict; adapters serialize the check and dispatch as far as their API permits.
Changes in remote permissions still require the host's normal authorization checks.

Expose coverage per adapter. Generic shell/MCP activity is not covered until an
adapter can identify the actual resource/operation and veto safely. When required
delivery cannot be established at an enforcement boundary, report that limitation
and block that configured boundary, rather than claiming enforcement succeeded.
Do not claim control over uninstrumented actions.

New routing behavior defaults off. An observation mode may record scoped selection
diagnostics but must not bind new instructions, change prompts, or veto actions.
Assistance enables restoration and advisory selection. Enforcement requires a
separate explicit policy and demonstrated adapter coverage. Final configuration
field names are settled during schema review; these are not installable options.
Skill learning remains separately opt-in in every mode.

## Evaluation and first acceptance

### V1 Phase 1 procedure continuity

This is the umbrella's first V1 implementation phase. Deliver one context owner,
exact durable bindings, complete prerequisite restoration, bounded allocation and
inspectable per-request receipts using existing approved skills. Persist at binding
boundaries; a compaction summary is not the store. Keep learning disabled in the
primary fixture to prove restoration does not depend on skill mining.

Acceptance requires twenty compactions, a missed compaction callback, controller
restart with no RAM hints, and a plain "continue" prompt with zero additional skill
reminders. Check exact instruction bytes and deduplication, scoped parent/child
delivery, interrupted binding writes, source/prerequisite drift, revocation, stale
delivery receipts and insufficient capacity. Test default caps, an explicitly
raised `perCall`, a lower cap, zero remaining capacity and separate compaction
limits. Optional content must not grow just because the mandatory ceiling grows.
Do not claim `host_confirmed` from simulated or plugin-only emission; verify the
actual pinned V1 hook boundary before making an installed-host delivery claim.

The phase adds no inferred mandatory rules, autonomous learning/compiler calls,
new sharing scope, automatic worker replacement, generic shell/MCP enforcement,
watcher, or V2 code/probes. It needs only the knowledge contract's minimal identity
and existing-approval checks, not all of its import/compiler machinery or the
execution contract's full recovery implementation. New assistance remains opt-in;
disabled behavior stays compatible, with any necessary safety delta documented.

### Next V1 phase and program evaluation

Add deterministic routing over approved manifests after continuity passes. Local
fixtures then add unnamed-skill selection, changed operation, conflicting rules,
unapproved proposals, exact resource predicates and explicit coverage gaps.
Advisory discovery can run without authority to create new mandatory rules; such
rules require the separately verified approval boundary. Compiler, watcher and
V2 readiness are not prerequisites for either phase.

Add a locally retained, sanitized corpus of past turns where the user had to name
a missed skill when available. Label the operation, applicable procedure and
information actually available then; retain later corrections separately. Separate
development cases from held-out cases, including by incident/session where needed.
Replay against exact skill/environment versions to avoid hindsight leakage.

Measure useful task completion, unnecessary activation, repeated diagnostics,
required-skill recall before commitment, invalid actions prevented, false blockers,
context bytes and all attributable model cost. Retrieval recall alone is not
competence. Synthetic cases remain mandatory and sufficient for deterministic
harness acceptance if air-gapped examples cannot be shared; live effectiveness
needs its own authorized evaluation.
