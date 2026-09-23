# Environment-aware skill and session memory — implementation plan

Status: implementation added, 2026-09-20. Validation authority is the separately
generated source-bound synthetic-gate report, not this planning document.
See `session-memory.md` for operator commands and explicit V1 refinements: no
host-delivery attestation/autocontinue hook, snapshot incident imports, in-process
derived index, whole-profile freshness, and revised 500 ms warm/500 ms cold gate.
The original proposed 100 ms warm target remains recorded as unmet. This document authorizes no
installation, production connection, credential discovery, deployment, or model call.

## Current status

The September 20 baseline above, including the note that recovery work was
uncommitted in an isolated worktree, describes that planning snapshot. It is not
the current tree. The canonical checkout is commit `dc55386` on `origin/main`,
in the worktree `D:\alg-worktrees\compaction-recovery-20260920`. Later changes
branch from that commit.

## Outcome

After compaction or restart, “continue” restores the correct operating environment,
applicable complete procedures, relevant verified solutions, and next unfinished
step. The harness does not need to rediscover connection syntax or repeat a solved
diagnostic merely because conversation text was compacted. Context remains bounded.

The graph is durable operational knowledge. Model context is a selected working
view, not the database and not the authority for permissions.

## Baseline and concrete gaps

Build on the existing isolated `codex/compaction-recovery-20260920` worktree, based
on main `1a0465d6ac5d2c8a8ce9280f4c170227deb82130`. Its uncommitted recovery repair
passed 95 targeted synthetic tests and typecheck; that is baseline evidence, not
validation of the features proposed here. Preserve the original checkout.

- `src/skill-catalog.ts`: complete-body loading and durable references exist, but
  selection still depends on in-memory hints; discovery is capped at 32 skills;
  guidance is coupled to `skillEvolution.enabled`.
- `src/skill-evolution-store.ts`: session recovery stores skill identities and
  capture counts, not task bindings, environment identity, verified resolutions,
  a context generation, or a transactional resume cursor.
- `src/index.ts`: system/message/compaction hooks exist, but there is no unified
  context budget, deterministic restoration pipeline, or repeat-attempt preflight.
- `src/experience.ts`: immutable evidence nodes and typed relations exist. Its
  project-private scope does not establish session visibility or authorization.
  `listExperience()` loads the store: do not put that scan on every model turn.
- `src/troubleshooter.ts`: verified incident transitions can supply resolution
  evidence; they do not currently drive contextual retrieval or tool preflight.
- `capabilities/connectors/`: endpoint and credential-reference contracts exist,
  but remote activation is intentionally blocked. Keep that boundary unchanged.
- Installed plugin SDK 1.18.3 declares system/message transforms, tool before/after
  hooks, compaction, and `experimental.compaction.autocontinue`. Declarations alone
  do not prove hook ordering, final prompt delivery, or universal tool interception.

## V1 decisions

1. Separate `sessionMemory` from `skillEvolution`. Deterministic skill restoration
   and lookup require no learning model. New memory mode defaults off; explicit
   modes are `off`, `observe`, and `assist`. Existing learning behavior stays
   compatible; when memory owns skill delivery, suppress the duplicate legacy
   formatter. Keep the V1 auditor/checker safety gate unchanged.
2. Keep session/task/attempt records session-private by default. Project skills
   already explicitly configured for use remain discoverable. Sharing a sanitized
   environment profile or resolution across sessions requires explicit project-level
   publication; cross-project sharing is out of V1. Filesystem access remains the
   actual isolation boundary: local hashes and session IDs are not authentication.
3. Use local immutable JSON objects, atomic session-head pointers, and a rebuildable
   bounded index. No new graph database, embeddings, external MCP, daemon, or
   network service is required for V1. Do not duplicate the existing evidence store.
4. Only approved environment targets may be selected. Passive local observations
   can suggest a PC/container/pod identity, but uncertain detection stays unknown.
   No port scans, credential searches, arbitrary API discovery, or remote activation.
5. Use synthetic fixtures and local deterministic host tests only. No production
   endpoints, paid model calls, or real PostgreSQL/S3/Kubernetes acceptance.
6. Do not promise lossless chat retention or model comprehension. Enforce durable
   state, complete instruction assembly, explicit missingness, and instrumented
   preconditions; test actual host delivery separately from prepared context.

## Contracts and storage

New modules live under `src/session-memory/`; use strict versioned schemas rather
than enlarging unrelated learning ledgers. Existing experience-v1 and run-v2
objects remain readable and byte-identical.

| Record | Required content |
| --- | --- |
| Environment profile/revision | Stable environment ID; execution origin distinct from target; host/cluster/namespace/tenant references; protocols/API/client versions; approved route and endpoint IDs; available-tool identities; credential-provider references, scopes and expiry metadata; source and last verification time. Never secret values. |
| Skill version/binding | Stable skill ID, complete body hash, source identity, applicable environments/tasks, prerequisites and explicit dependency hashes; task/step binding; activation/completion state; reviewed supersession policy. |
| Attempt/resolution | Environment revision, structured operation signature, applicable preconditions, outcome, source receipt IDs, verified procedure version, freshness and invalidation conditions; distinguish proposed, observed, verified and superseded. |
| Session checkpoint | Project/session owner, revision and parent hash, task epoch, context generation, selected environments, pinned constraints and goals, active skill bindings, completed/blocked/next steps, source cursors and coverage gaps. |
| Context receipt | Checkpoint revision, selected node/skill IDs and hashes, selection reasons, omitted counts/retrieval cursors, token-estimator identity and budget, generated-context hash, and delivery state. No copied secrets or full tool logs. |

Storage: `.opencode/session-memory/objects/<sha256>.json` for immutable typed
records; `heads/<hashed-session>.json` for atomic owner-bound checkpoint pointers;
`index/` for replaceable indexes. Reuse audited direct-file readers, canonical
serialization and mutex/fencing helpers. Verify hashes, schemas, ownership and
dependency closure on reload. Publish objects first, then advance the head with
revision CAS. Never advance a replay cursor after a failed durable write.

Wrap links to existing experience/incident/run records with explicit visibility
and provenance; do not infer shareability from a generic `project-private` flag.
Relations needed for retrieval include applies-to, requires, resolved-by,
attempted-in, supports, refutes and supersedes. These are typed memory-layer links,
not an incompatible rewrite of the existing experience schema.

Retain approved exact skill versions in bounded private artifacts when possible.
Only configured skill sources and explicitly declared instruction dependencies
are eligible: do not crawl arbitrary linked files. Reject/quarantine suspected
secret-bearing content rather than silently redacting executable instructions.
Detection is defense in depth, not a DLP guarantee. A changed/revoked skill or
dependency requires review; neither silently adopting the new bytes nor silently
executing an obsolete archived procedure is acceptable.

## Runtime behavior

### Before the next model turn

1. Resolve the exact session/task epoch and environment binding from durable state.
2. Validate checkpoint integrity, scope, revocation, environment revision and skill
   dependency identities. Restore active bindings even when the latest user text
   is only “continue”; fresh text augments retrieval, not the only selection key.
3. Select mandatory orientation and applicable complete skill/module closures.
   Add relevant verified solutions, contradictory evidence and failed attempts.
4. Build one ALG-owned context pack under the budget. Persist its receipt; append
   without mutating other plugins' chunks. Distinguish `prepared`/`emitted` from
   host-verified delivery. No receipt proves the model understood an instruction.
5. At an instrumented action boundary, verify the applicable environment and
   procedure binding and repeat-attempt policy. Refresh current permissions
   through the normal host/adapter authority, independently of remembered facts.

Explicit task completion/switching deactivates the old bindings. Environment
switches invalidate origin-specific reachability and incompatible procedures.
“Continue” preserves bindings; a new task does not inherit every historical skill.

### At ordinary completion, compaction and restart

- Record typed attempt/outcome receipts at ordinary action boundaries, not just
  at compaction. Verify success against declared acceptance checks before marking
  a resolution verified. Model-authored notes remain proposals until supported.
- At compaction, checkpoint active bindings, progress and coverage. Rebuild the
  next context from durable state even if the host summary omits all skill names.
- Use the autocontinue hook only if local host conformance tests establish its
  behavior. Pause synthetic auto-continuation when mandatory recovery is blocked,
  with a user-visible reason; it is not a general permission or message barrier.
- On restart, recover committed state idempotently, reject partial writes and
  replay only acknowledged supported source events. If the host offers no complete
  replay stream, keep the cursor/coverage limitation explicit.
- Bind child-worker context with an explicit scoped delegation ticket before its
  prompt. Do not copy parent credentials or complete transcripts. Checker context
  remains independently scoped and does not receive private worker reasoning.

## Context and discovery budgets

The following are initial engineering limits to validate, not measured optima:

- Discover/index up to 10,000 skill descriptors, pages of 64; default lookup returns
  12 ranked descriptors and a cursor. Cap metadata/index bytes and scan duration
  independently. Reaching a bound reports incomplete discovery; never treat it as
  “no applicable skill exists.” Invalidate changed roots and reverify selected files.
- Traverse at most two graph hops, 24 nodes and 48 edges per context selection.
  Rank explicit active bindings first, then verified environment matches and
  applicable resolutions, then lexical task matches. Preserve opposing evidence;
  use stable deterministic tie-breaking and expose selection reasons.
- Default ALG pack ceiling: 8,192 tokens and 10% of the declared model context,
  further reduced by estimated remaining input capacity after response/tool-output
  reserves and a safety margin. Record which model/tokenizer or estimate was used.
  Unknown host usage uses a smaller configured fallback and an explicit unknown
  total-headroom warning; byte counts are not token counts or a universal proof.
- Reserve up to 1,024 tokens for orientation (goal, constraints, environment,
  coverage, next step, lookup pointers), then required procedures, then resolutions.
  All share the same ceiling; unused reservations are reusable. Optional context
  is evicted before required instructions.
- If mandatory content cannot fit, return `needs_context` and split the task into
  procedure stages or load a complete authored module with all required dependencies.
  Never summarize away a prohibition or pretend a clipped skill was fully loaded.
  Preserve the current 64 KiB maximum skill-file read as a separate I/O safety cap.

Large skills can gain optional versioned companion manifests describing complete
modules and shared constraints; existing SKILL.md files remain atomic by default.
Do not auto-split instructions using arbitrary character or token boundaries.

## Repeat-work prevention

Construct signatures only from adapter-approved non-secret dimensions: tool and
operation IDs, environment/principal-scope references, resource/template identity,
skill version and relevant parameters. Do not persist raw commands/URLs containing
credentials or low-entropy secret hashes as a shortcut to deduplication.

For a matched prior attempt, distinguish:

- verified and still applicable solution: load the procedure and resume at the next
  unfinished step; do not claim an old response is a fresh measurement;
- identical failed attempt with unchanged preconditions: provide the earlier
  failure and alternative, and require a structured reason/evidence before retry;
- changed environment, expired evidence, explicit refresh, deliberate regression
  test, supported transient retry, or scheduled polling: permit the appropriate
  bounded action under normal permissions and record the reason;
- similar but uncertain match: advise only; never hard-block from fuzzy similarity.

Start in observe mode. Enforce only exact matches and required preconditions inside
ALG-owned/explicitly integrated wrappers. SDK tool hooks may enrich coverage after
verification, but generic bash and arbitrary MCP tools are not universally
intercepted or made safe by this plan. Unknown/uninstrumented coverage is visible.
Exceptions are scoped to one exact operation/version/expiry, not blanket bypasses.

## Implementation sequence

### P0 — Preserve the repair and prove the host contract

- Review/checkpoint the existing repair separately before mixing in new features.
- Add `tests/session-memory-host.test.ts` with deterministic provider/tool fixtures:
  capture the actual assembled prompt, force compaction, restart, exercise tool
  ordering, and check cancellation/error/auto-continue behavior on pinned 1.18.3.
- Record a capability matrix: prepared context, observable delivery, callback
  ordering, supported action wrappers and unsupported enforcement surfaces.
- Exit: original regressions remain green; unsupported behavior has an explicit
  fallback rather than a guessed SDK guarantee. No real model calls.

### P1 — Restore skills reliably, independently of learning

- Add `schemas.ts`, `store.ts`, `runtime.ts` and `skill-index.ts` in the new module.
  Extract common safe persistence helpers if needed; do not introduce a second
  weaker file reader. Add the independent strict plugin configuration.
- Persist task-scoped active skill/dependency bindings and context generations.
  Implement paginated metadata discovery, complete-body loading, drift/revocation
  handling, deactivation and read-only migration of prior recovery references.
- Enforce the initial token-aware skill budget here; P3 extends it to the complete
  graph/context pack rather than introducing budget enforcement for the first time.
- Replace hint-only restoration in `src/skill-catalog.ts`/`src/index.ts`; leave
  learning intake and candidate promotion separate. Add real reviewed repinning.
- Exit: skill 87 in a 100-skill catalog restores after compaction and a new runtime,
  using only “continue,” with learning disabled. Full selected bytes are present;
  changed/missing dependencies do not silently substitute. Unrelated skills stay out.

### P2 — Bind knowledge to the actual environment

- Add `environment.ts`: reviewed versioned profiles, explicit target selection,
  passive local fingerprints, origin-specific routes and per-field freshness.
- Reuse connector contract references without activating remote connectors.
  Model PC, pod and remote server execution as distinct origins, and APIs as
  targets with protocol/auth-reference/capability metadata.
- Add explicit operator bind/unbind/review commands; uncertain selection blocks
  environment-dependent actions rather than defaulting to a similarly named target.
- Exit: two environments with identical symptoms select different procedures;
  a PC-to-pod switch, identity change and credential expiry invalidate the right
  observations; zero network discovery and zero secret values in storage/prompts.

### P3 — Build the bounded working graph and context pack

- Add `retrieval.ts`, `context.ts` and `experience-adapter.ts`; implement scope-first
  lookup, verified dependency traversal, budget accounting and selection receipts.
- Add four explicit tools: `alg_memory_search`, `alg_memory_read`,
  `alg_context_status` (read-only), and `alg_memory_propose` (writes unverified
  proposals only). Explicit operator commands handle reviewed publication,
  authoritative bindings, repinning and revocation; model booleans cannot approve.
- Update `ALG_TOOL_IDS`, startup messages, exact registration tests, documentation,
  source/packaging/live-proof contracts together. This intentionally expands the
  present 15-tool contract; do not silently add tools under unchanged assertions.
- Exit: bounded deterministic selection restores mandatory pins, distinguishes
  inferred/verified/contradicted facts, and rejects foreign or tampered nodes.
  Large catalogs/stores do not cause per-turn full-store scans or unbounded output.

### P4 — Reuse verified resolutions and prevent accidental loops

- Add `attempts.ts` and `preflight.ts`; integrate typed attempt receipts and
  verification with `src/troubleshooter.ts`, existing run/evidence receipts and
  selected ALG-owned tool wrappers. Add scoped child delegation in `src/sessions.ts`.
- Separate observation capture from model-assisted proposal extraction. No new
  model is required to restore a skill, compare an exact attempt, or retrieve a
  verified resolution. A successful command alone is not proof the task was solved.
- Exit: the golden scenario resumes without rediscovery; an unchanged failed
  attempt is intercepted in supported wrappers; polling, fresh validation and
  changed conditions still work. No auto-remediation or permission escalation.

### P5 — Validate, expose diagnostics and roll out conservatively

- Add `scripts/session-memory-gate.ts` and focused unit/property/integration tests.
  Report context size, restore success, selection rationale, duplicate attempts,
  coverage gaps, rejected stale scope, disk growth and latency with source receipts.
- Initial synthetic performance targets: warm indexed selection/context assembly
  p95 <=100 ms, cold verified restore p95 <=500 ms for a 100-skill/1,000-node fixture;
  record hardware/runtime and distributions. A missed target requires optimization
  or an explicit revised budget, not a fabricated pass. External waits get bounded
  deadlines; no broad disk scan or network call belongs in the hot path.
- Test off -> observe -> assist modes, both with learning off and on. The global
  mode stays opt-in; repeat prevention is enabled only for attested wrappers.
- Exit: synthetic gate, typecheck and affected existing suites pass; run applicable
  package/source/registration gates. Extend existing isolated no-model host proof
  where appropriate. Report all unrun real-service/model acceptance as NOT_MEASURED.
  Installation/push/deployment require separate follow-through, not this plan.

Dependency order: P0 -> P1 -> P2 -> P3 -> P4 -> P5. Budget/storage interfaces are
fixed in P1; P3 implements the complete shared pack. Do not defer budget enforcement
until after the memory has already been injected. P1 is the first useful delivery.

## Acceptance matrix

| Scenario | Required result |
| --- | --- |
| Solve connection issue; 20 compactions; destroy runtime; “continue” | Correct environment, complete skill version and next step restored; no replay of satisfied setup; one stable verified-resolution identity. |
| 100+ skills, relevant entry after the old 32 limit | Found through bounded discovery; only applicable instructions injected. |
| Learning disabled | Restoration/lookup work with zero additional auditor/checker/model calls. |
| Model/context budget shrinks; multilingual oversized skills | Pack stays within declared measured budget or explicitly blocks on mandatory overflow; no partial instructions. |
| Host summary drops every skill name | Checkpoint still restores task bindings without lexical hints. |
| Skill or dependency changes/revokes | Review required; no silent version substitution; reviewed repin is durable. |
| Same API from PC, pod, alternate tenant or principal | Route/solution scope does not cross environments; current authority checked. |
| Identical known failure vs polling/fresh verification | Unchanged accidental loop intercepted; legitimate repeated work permitted and explained. |
| Tamper, foreign session, injection in a log, secret-bearing source | Integrity/scope failure or quarantined proposal; no instruction or permission promotion. |
| Crash before/after object publication and head replacement; concurrent writers | Last valid committed checkpoint survives; no cursor skip, lost update or duplicate verified resolution. |
| Missing host events or capture timeout | Coverage stays degraded; no invented transcript or success. |
| Child worker/checker and task/environment switches | Only authorized relevant bindings propagate; no private worker-reasoning leakage or permanent sticky skills. |
| Corrupt/stale index and storage capacity | Rebuild/revalidate within bounds or stop visibly; authoritative objects are not silently deleted. |
| Feature disabled and older stored state | Existing behavior/records remain compatible; no automatic migration writes or store initialization. |

## Review, retention and rollback

Keep new storage separate and legacy inputs immutable. Migration is explicit,
idempotent and records source hashes; an old skill hash alone is not proof of
current task applicability or verified resolution. Initial hard limits include
10,000 memory objects, 32 KiB per typed object, 64 KiB per checkpoint, and 4,096
session heads, plus a separately enforced total-byte quota for skill artifacts.
The initial artifact quota is 128 MiB/project, configurable within validated
bounds. Exhaustion pauses capture visibly; no silent eviction.

Retention is explicit review: distinguish disposable indexes/context receipts from
pinned facts/skill versions needed for recovery. Deletion/revocation tombstones
prevent automatic reinjection and allow a separately authorized cleanup workflow.
Disabling memory removes its context/preflight effects but preserves data for
inspection; rolling back code must not reinterpret or overwrite newer schemas.

This plan stops at a synthetic-tested, opt-in operational memory layer. Automatic
cross-project sharing, new remote connectors, port scanning, credential discovery,
universal MCP interception, semantic/vector retrieval, and lossless host message
archiving are separate extensions—not hidden prerequisites for fixing skill loss.
