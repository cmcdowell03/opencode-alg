# Environment memory engine: phased implementation

Status: approved for implementation by the user on 2026-09-23. This plan is
authored by the orchestrator. GPT-6 Luna implements it; GPT-6 Sol reviews and
corrects the implementation and performs verification. PR #4 is merged at
`84f21b1`; this work starts on `codex/environment-memory-engine`.

## Outcome and scope

Deliver an opt-in environment memory engine that records a connection with its
evidence and restrictions, answers scoped relationship queries, survives process
restart and snapshot restoration, and stops presenting facts after expiry or
revocation. A bounded RAM cache accelerates an embedded SQLite store. Immutable
snapshots and journal batches can be replicated to a local directory or S3.

This PR delivers phases 1-4 below as one usable vertical slice. Phase 5 contains
optional optimizations with explicit adoption gates. Remote configuration is
supported, but acceptance uses synthetic data and injected/local transports. No
live service discovery, credential search, paid model call, real bucket, or
production connection is needed. All behavior remains model agnostic.

## Invariants

- The existing session-memory store and defaults remain compatible. The new engine
  defaults off and performs no initialization, database import, or network I/O
  when disabled. Existing run authority, skill completeness, owner validation and
  tool permission checks remain in force.
- Keep current environment state distinct from event history and semantic search
  indexes. A transaction appends an event and updates its current projection
  atomically. Publish committed revisions to RAM only after that transaction.
- Store exact IDs, evidence references, source type, observation time, expiry and
  revision. Distinguish declared, observed, inferred and unknown facts. Model prose
  never promotes itself to an observed fact or an authorization grant.
- Reachability, authentication and authorization are separate relations. A service's
  database privilege is not inherited by its caller. Rule records describe scoped
  requirements; actual adapters continue to validate authority at action time.
- Scope records to a namespace/project and either a session owner or explicitly
  published project visibility. Every read, graph traversal, cache and restore
  checks scope. An explicit namespace permits reviewed relocation to another host;
  paths and hostnames alone are not portable identity.
- Credentials remain provider references, without secret values or bearer URLs.
  Reuse existing secret detection and path safety where applicable. Treat source
  text as data when rendering it into context.
- Capacity exhaustion is visible. Bound record sizes, reads, traversals, cache
  entries and replication batches. Eviction applies to rebuildable RAM entries;
  never silently discard committed evidence or unsynced events.

## Shared contracts

Use `src/environment-memory/` with small explicit modules. The core worker owns
`schemas.ts`, `engine.ts` and `index.ts`; the replication worker owns `replication.ts`
and `object-store.ts`. Integration owns `runtime.ts` and edits outside this folder.
Workers may add focused helper files within their assigned area. Keep dependencies
acyclic: schemas <- engine; schemas <- replication; runtime composes both.

## Architecture and code-quality contract

Architecture is an acceptance criterion for every phase. Keep a short decision
record in `docs/environment-memory-design.md` explaining the final boundaries,
durability model, alternatives rejected and measured reasons for optimizations.
Update this record when implementation or review changes the design.

| Component | Responsibility | Must not own |
| --- | --- | --- |
| Schemas/domain | Record validation, scope, provenance, identities | Filesystem/network access or OpenCode hooks |
| SQLite engine | Transactions, event chain, projections, exact queries | S3, provider models or prompt rendering |
| RAM cache | Bounded acceleration of committed, scoped reads | Independent authority or uncommitted facts |
| Object-store adapter | Bounded byte operations and conditional publication | Environment semantics or credential persistence |
| Replication coordinator | Snapshot/log manifests, integrity and durable progress | Silent conflict resolution or authorization |
| Plugin adapter | Lifecycle, session validation and context budgets | Database internals or remote signing |
| CLI/benchmark | Explicit user workflows and reproducible measurement | Alternate persistence or policy implementations |

Design rules:

1. Maintain one authoritative implementation of validation, hashing, scope checks,
   freshness and state transitions. CLI, context and replication call those same
   functions. Avoid subtly different implementations for each consumer.
2. Use narrow typed inputs/outputs and explicit dependencies. Do not add generic
   repository/service frameworks, dependency-injection containers, ambient mutable
   globals, or interfaces with only speculative consumers. Introduce an interface
   where there are concrete implementations or a meaningful test boundary.
3. Make transactions and lifecycle ownership visible. Document which operation
   owns the connection, commits a revision, acknowledges remote durability and
   closes/cancels resources. Cache updates follow commit; restore publishes one
   complete state. Partial success must have a typed result.
4. Use named error categories for conflicts, stale evidence, capacity, corruption,
   unsupported runtime and remote availability. Do not classify errors by matching
   message text. Preserve useful causes internally and sanitize external diagnostics.
   Never convert an unknown failure into empty successful state.
5. Prefer cohesive modules and straightforward functions. Extract helpers when
   they remove actual duplication or express a domain operation. Avoid wrappers
   that merely rename one call, large configuration surfaces, unnecessary casts,
   and parallel schemas that can drift.
6. Separate portable domain/replication code from the Bun SQLite binding. Lazy
   activation must preserve existing disabled and Node/packaging paths. Any new
   dependency needs a concrete purpose, pinned identity and packaging coverage.
7. Preserve explicit semantics for evidence, cache revision and time. A cached
   result is reevaluated for expiry and scope; a revoked rule cannot return through
   an old snapshot or merge. Do not implement arbitrary executable policy strings.
8. Optimize observed hot paths. Use indexed lookups, bounded caches and batch I/O;
   keep measurements for serialization, scans and allocation. Low-level rewrites
   require evidence of a bottleneck and must preserve the same public contract.

Architecture review gates:

- Before dependent workers start: freeze exported record types and core/replication
  method signatures; record the storage and concurrency decisions in the design
  note. Workers report contract changes before editing another worker's consumer.
- Before integration: document the real call path from import to commit to cache,
  and from snapshot upload to manifest publication to recovery. Resolve unclear
  ownership and duplicate state before adding plugin hooks.
- Before making the PR ready: Sol examines every changed source line and evaluates
  the complete design against this contract, simplifies awkward APIs/abstractions,
  fixes issues directly, and records remaining limitations with evidence. A green
  test run alone does not satisfy the design review.

The core exports `EnvironmentMemoryEngine.open(options)` asynchronously, loading
`bun:sqlite` only when requested. Instance operations are synchronous except remote
work. Use native SQLite transactions/WAL with durable settings, prepared queries
and indexes. Do not introduce a custom database engine or ORM.

Core records:

- `Entity`: stable ID, kind (host, pod, network, endpoint, API, repository,
  deployment, database, dataset, principal, credential-provider or rule), bounded
  label and bounded typed metadata, scope and provenance.
- `Relation`: stable ID, source/target IDs, explicit relation kind such as runs-on,
  routes-through, calls, deployed-from, reads-from, authenticates-as or constrained-by;
  scope, provenance and optional validity conditions. References must resolve in
  the same namespace and must not broaden session visibility.
- `Event`: schema version, namespace, monotonic revision, previous event hash,
  content hash, timestamp and a validated upsert/revoke operation. Idempotency keys
  prevent a repeated import from becoming another observation.
- `Provenance`: source reference and source type, evidence classification,
  observed/verified time and expiry. Invalidation/revocation remains explicit.

Public engine operations, with names finalized in phase 1 and communicated to all
workers before dependent code is written:

1. `append(operation, {expectedRevision, idempotencyKey})` returns a committed
   revision/hash. Conflicts do not overwrite newer facts.
2. `get(id, scope)` and `query({scope, roots, maxDepth, maxNodes, now})` return only
   visible current records, with stale/missing/omitted counts. An explanation of a
   path retains each edge's own principal and restrictions.
3. `status()` reports revision, counts, configured capacities and cache statistics.
4. `exportSnapshot()` returns a bounded portable versioned object containing
   namespace, current projections and the journal cursor/hash. `eventsSince(revision)`
   exports bounded contiguous journal batches.
5. `restoreSnapshot(snapshot)` accepts an empty destination by default; replay of
   subsequent events validates namespace, content hashes, sequence and chain anchor.
   No silent overwrite of an existing namespace. Restore/replay is transactional.
6. `close()` releases resources; reopening reconstructs the same current view.

Snapshots use canonical, schema-validated JSON in this first delivery. Every blob
has its own SHA-256 identity. This preserves a small dependency set and gives the
later Parquet format a clear compatibility boundary. Hashes establish integrity;
they do not independently authenticate a publisher.

## Phase 1: transactional core and bounded RAM

Implement the records and operations above, with an LRU or similarly bounded cache
keyed by namespace, scope and revision. Freshness is checked at read time even for
cached entries. SQLite remains authoritative; cache loss is harmless. Make stale
cache invalidation work when another local engine connection commits.

Use a single logical writer per namespace for this release, with SQLite locking
and revision comparisons protecting concurrent local attempts. State explicitly
that independent writable replicas require coordination rather than automatic
merging. Local storage must provide supported database locking/flush guarantees;
do not open a mutable SQLite database through an S3 filesystem mount.

Acceptance: append/reopen equivalence; transaction rollback; expected-revision
conflict; idempotency; cross-owner/project denial; expired and revoked paths;
identity-specific access paths; bounded cache/queries; explicit capacity errors;
snapshot plus journal replay equivalence and corruption rejection.

## Phase 2: immutable replication and recovery

Define an injectable `ObjectStore` with bounded `get`, immutable `putIfAbsent` and
conditional manifest replacement using an expected version token. Implement local
directory and S3 adapters. Use an established S3 client/signing implementation,
loaded only when S3 is configured; pin any new dependency and update both lockfiles.
Credentials are supplied through the client's standard external credential
provider, never recorded in engine state or configuration examples.

Upload content-addressed snapshots and journal batches before publishing a small
manifest containing namespace, sequence, hashes and predecessor. Readers follow a
complete manifest, not a directory listing. Validate all referenced objects before
restoring. A failed conditional update leaves the previous manifest authoritative;
orphan uploads are harmless and may be cleaned only by a future retention policy.

Return distinct receipts for local commitment and remote replication, including
the highest replicated revision and pending lag. A local commit does not claim to
survive destruction of ephemeral pod storage. Replication retries are idempotent,
bounded and cancellable. Preserve pending work when the remote store is unavailable.

Acceptance: interrupted upload, missing/corrupt segment, manifest contention,
duplicate upload, offline retry, timeout/cancellation and wrong namespace all have
deterministic outcomes. Recover an empty local store from a committed snapshot plus
later events. S3 conformance is exercised through an injected fake client/transport;
reports explicitly identify real S3 behavior as unmeasured.

## Phase 3: explicit intake and OpenCode integration

Add an operator CLI for init/import/query/status/snapshot/replicate/restore and
examples that demonstrate the full cycle. Imports are reviewed structured files;
automatic hardware/network discovery is outside this delivery. Use passive,
synthetic inputs for fixtures. Remote activation is explicit.

Add an optional `environmentMemory` configuration with mode off/observe/assist,
explicit namespace/storage path, configured root entity IDs and a small context
byte budget. Open/close the engine with the plugin lifecycle. Observe mode produces
diagnostics only. Assist mode renders a scoped, bounded environment view with
source IDs, stale/unknown warnings and omitted counts. Reserve existing mandatory
skill/task context; environment overflow cannot truncate required procedures.

Provide a read-only expansion path through the existing memory/status tools if it
can preserve their contracts cleanly; otherwise use a narrowly named optional tool
with all registry/docs/tests updated. Do not create model-facing writes that can
assert verified facts. Existing environment profiles are imported only through an
explicit adapter; legacy files remain untouched and usable.

Acceptance: disabled mode has no side effects or Bun-only import on supported
non-Bun paths; normal/restarted/compacted sessions recover the same visible graph;
foreign sessions see no private records; stale facts cannot become active context;
complete skills retain priority; existing memory and learning tests pass.

## Phase 4: synthetic lifecycle and endurance assessment

Provide a deterministic world fixture: PC, pod, gateway, API, repository,
deployment, database and two principals with different permitted paths. Exercise
connection learning, solution/skill references, repeated compactions, restart,
snapshot replication/recovery, route changes, expiry and revocation.

Add a bounded benchmark/soak CLI with configurable seed, event count, graph size,
restart frequency and duration. Measure actual elapsed time, operations, p50/p95
query/commit/recovery latency, RAM high-water, database/object bytes, cache bounds,
replication lag, retained facts and invalid route/permission claims. Emit source
revision/config/runtime identity and raw or reproducible measurements. Do not
label a short accelerated run as a 24-hour or 72-hour result.

Run a short deterministic smoke and affected regression suites in this PR. Document
commands for longer 24/72-hour runs and provider-paired evaluations. Those optional
long-running or paid evaluations require their actual execution before any claims.

## Phase 5: measured optimizations

These are planned follow-ups, not placeholder features or completed claims:

- Full-text baseline then optional embeddings/LanceDB when retrieval evaluation
  shows a benefit. Version the embedding model/index independently of assistant
  models. Candidate retrieval always rechecks authoritative records and scope.
- Parquet history/snapshots and Arrow batch interchange when inventory/history
  volumes justify them. Preserve schema, identity and restore compatibility.
- Rust cache/traversal components only if profiling identifies CPU/allocation as
  a material bottleneck after removing repeated scans and serialization.
- Retention/checkpoint compaction and coordinated multiple writers after defining
  deletion, revocation, remote acknowledgment and recovery guarantees.

## Delivery and review

The orchestrator commits this plan and opens the draft PR. Luna A implements phase
1. Luna B implements phase 2 against the shared contract in disjoint files. Luna A
then implements phase 3 and Luna B phase 4, with file ownership coordinated before
edits. Workers report changed paths and concise test results; no duplicate reviews.

GPT-6 Sol reviews the complete diff line by line for correctness, API clarity,
unnecessary abstraction, duplication, lifecycle handling, compatibility, race and
crash behavior. Sol directly fixes findings and runs the relevant regression,
type/package and synthetic gates. The orchestrator handles commits, pushes and PR
status from Sol's evidence, without repeating its code verification. The final PR
description distinguishes implemented phases, actual test evidence and deferred
work. New PR merge is a separate action from delivering this implementation.
