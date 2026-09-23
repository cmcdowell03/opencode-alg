# Environment memory design record

Status: phases 1-4 are implemented as an opt-in synthetic-tested vertical slice.
This record describes its authority, transaction, and lifecycle boundaries.

## Boundaries and call paths

`schemas.ts` owns the versioned domain and wire schemas, bounded field sizes,
scope/provenance validation, operation/result types, and named engine error
categories. It has no filesystem, SQLite, network, or plugin dependencies.
`engine.ts` owns the opt-in Bun SQLite adapter and domain transitions. `index.ts`
is the public barrel. The engine is opened only by an explicit caller; importing
the barrel does not import `bun:sqlite` at runtime.

The local write path is:

1. A caller validates an `EnvironmentMemoryOperation` and its expected revision
   and idempotency key.
2. `append` begins `BEGIN IMMEDIATE`, checks duplicate-key identity and current
   revision, validates endpoint and scope rules, and constructs a hash-linked
   event.
3. One SQLite transaction appends the event, changes identity/revocation state,
   updates the current entity/relation projection, and advances the journal head.
4. Only after `COMMIT` does the engine clear its RAM cache and publish the new
   observed revision. Read transactions see one SQLite revision; another
   connection's committed revision invalidates the local cache. Cached values
   are copied before returning and freshness is checked on every read.

The read path checks the caller's namespace/project/owner, current database
revision, evidence expiry, and relation validity. Private session records are
visible only to that owner; project records are visible inside that project.
Bounded graph traversal returns relation records and edge-specific paths, retaining
principal references and restrictions. These are evidence only: `reaches`,
`authenticates-as`, and `authorized-for` are distinct relation kinds, and no
engine result grants permission to perform an operation.

The current replication path in `replication.ts` is:

1. `replicateEnvironmentMemory` reads a local snapshot or a bounded contiguous
   `eventsSince` segment from the engine.
2. It canonicalizes and hashes the bytes, writes immutable content-addressed
   objects using `ObjectStore.putIfAbsent`, then conditionally replaces the
   manifest using its expected version. The manifest is the commit point; an
   uploaded object without a manifest reference is an orphan, not replicated
   state.
3. `restoreEnvironmentMemory` reads the committed manifest, validates and hashes
   every referenced snapshot and event segment, checks the complete revision/hash
   chain, and passes the snapshot plus ordered batches to one SQLite
   `restoreWithReplay` transaction. A semantic replay failure rolls back the
   entire recovery. Snapshots include live and revoked identities and all
   idempotency receipts; current projection alone cannot preserve these rules.

The coordinator reports local SQLite commitment and object-store progress
separately. A local commit means SQLite's configured WAL/`synchronous=FULL`
commit completed on the supplied local filesystem. It does not promise survival
of ephemeral storage loss. Replication progress is reported only after conditional
manifest publication. The bytes and hashes establish integrity, not publisher
identity or authorization. The object-store adapter is an injected boundary;
synthetic/local tests do not establish behavior against a live S3 service.
The local directory adapter flushes object and manifest files and attempts
directory flushes; Windows does not provide this directory flush through Node,
so crash durability of its directory entries is not established. The directory
backend is for trusted local storage, not an adversarial writable directory.

The Phase 3 adapter opens and closes the engine only for explicit
`environmentMemory` mode `observe` or `assist`. `off` must not initialize storage
or import the Bun binding. Reviewed structured imports call the same `append`
validation path. Read-only status/context use `query`; observe reports diagnostics
only, while assist adds bounded, visibly untrusted orientation after mandatory
task and complete-skill context. The plugin uses an explicit project ID or the
host's project ID, and validates the session owner before rendering context.
No model-facing write operation is exposed. The existing 19 tool IDs remain;
session-memory status and hash-ID reads retain their prior shape and priority.

## Concurrency and lifecycle

SQLite is authoritative. Each database file is bound to one namespace. Writers
use SQLite's immediate transaction lock, an expected-revision comparison, and a
unique idempotency key. Contending local connections serialize; a stale expected
revision returns `CONFLICT`. A retry with the same key and same operation returns
the original committed receipt; reuse with different content conflicts. The
current release assumes one logical writer per namespace. Independent writable
replicas are not merged automatically and require an external coordinator.

`open` is asynchronous because it lazily imports Bun's native SQLite module;
engine operations are synchronous. The owner of the open connection calls
`close`. Restore accepts an empty destination only. A restored snapshot sets a
new journal base cursor; the local event log contains only later events, so
requests for events before that cursor fail rather than returning an incomplete
history. The idempotency table retains prior receipts even though old event
payloads are absent locally. A local manifest lock serializes directory CAS;
a process crash while holding that lock can require operator cleanup after the
bounded lock wait. No automatic stale-lock reclamation is claimed.

## Capacity and retention

The core limits one record to 64 KiB, a snapshot to 16 MiB, an event batch to 512,
graph depth to 8, and query output to 256 entities (defaults: depth 3 and 64
nodes). Each outgoing relation read and returned path list is capped. The LRU
defaults to 512 entries and is capped at 8,192. Each record and snapshot is
byte-checked; restore limits aggregate referenced bytes to 64 MiB. These limits
do not cap total SQLite file growth. There is no retention,
compaction, or automatic deletion policy in this phase. Revocation removes a
record from the current projection and records the revocation event; historical
events remain immutable. RAM entries may be evicted because SQLite is authoritative.

Credential-shaped content is rejected through the existing evolution redactor;
the engine stores credential-provider references only. Unknown or failed parsing,
integrity, or storage operations are surfaced as typed errors and never become an
empty successful graph.

## Alternatives and deferred optimization

The implementation uses Bun's built-in SQLite rather than adding an ORM or a
second database dependency. WAL, prepared statements, scope indexes, and a bounded
LRU keep the first version direct and inspectable. Snapshots and journal batches
use canonical JSON so existing code can validate and replay them without a new
binary format. S3 signing/client selection belongs to the explicit replication
adapter and its pinned SDK dependency, not to the domain engine.

No performance result currently justifies embeddings/LanceDB, Parquet/Arrow, or
Rust. Those remain later phases conditioned on measured retrieval benefit,
archive scale, or a profiled CPU/allocation bottleneck. This delivery makes no
claim that these optimizations are implemented or needed.
