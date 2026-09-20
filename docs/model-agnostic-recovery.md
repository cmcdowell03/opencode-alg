# Model-agnostic learning and recovery

These repairs respond to the September 20 synthetic benchmark. They use host
message identities, finish reasons, source hashes and explicit resource budgets.
No provider/model-name branch, tokenizer assumption or reasoning-level exception
selects the behavior. Models remain configuration inputs, not policy inputs.

## Completed-turn learning

Automatic intake and replay require a successful host assistant `finish: stop`
with a completion timestamp. Tool-call steps, summary messages, errors, length
limits and unknown finishes do not start an audit. The final assistant identity
anchors provenance; all completed steps sharing its session and parent user are
eligible evidence. Duplicate envelopes use their last version. A durable parent
user identity prevents duplicate new-format final envelopes from creating another
audit. Existing per-message ledger records are not rewritten or discarded.

Evidence remains bounded and redacted. When tools exceed the budget, both early
failure and late resolution steps are sampled; omission counts stay explicit.
Successful skill loads are determined before excerpt truncation. Catalog context
prioritizes loaded and exact-name entries ahead of optional discovery metadata.
Legacy immutable evidence without finish metadata remains readable, but automatic
replay is blocked pending manual review. It is not silently reinterpreted as
new-format completed-turn evidence.

## One skill discovery implementation

Learning and memory share the bounded skill index and metadata parser. Discovery
is no longer cut off at 32 skills. The index retains descriptors, not instruction
bodies; only selected bodies are reread, hash-checked and injected whole. The
existing 10,000-entry, two-second and 8 MiB metadata limits remain. Incomplete
discovery and rejected entries are exposed; a truncated index is not exhaustive.

In session-memory mode, keyword/description similarity is a search suggestion,
not authority to create a mandatory binding. Exact user skill names and actual
successful skill-tool loads may bind a unique source. Duplicate names require
explicit source-key review. Existing bindings are not automatically removed:
inspect and unbind obsolete selections using the operator memory CLI.

## Deadlines and child lifecycle

`skillEvolution.callTimeoutMs` defaults to 120,000 (range 1,000–300,000).
`skillEvolution.auditTimeoutMs` defaults to 300,000 (range 1,000–900,000).
The latter bounds one live audit attempt across its source reads, auditor and
checker; queue wait is not charged. Historical runs keep their separately sealed
budgets. Both settings apply identically to every configured model.

Transport timeout/disposal triggers a host `session.abort` for the owned child,
with an independent five-second cleanup deadline. Lifecycle state is durable.
Positive abort acknowledgment plus a host status with no active work confirms
cancellation; otherwise it is `uncertain`. A subsequent child for that parent
must reconcile unresolved work before creation. Unknown legacy child lifecycles
are not retroactively attested. Cancellation does not claim zero billable usage.
All existing tool-permission guards remain; the V1 builtin tool map is not a
universal deny-all guarantee for MCP/custom tools.

## Results, completed work and trust

Enabled memory captures the final answer at the terminal host event and again
before compaction. It stores a session-scoped, content-addressed artifact (maximum
64 KiB), an up-to-2,000-byte excerpt and bounded redacted tool evidence. At most
eight recent result references are active. Older objects remain durable but are
not automatically packed. Task/environment boundaries exclude old result pins.
The artifact and tool-evidence hashes establish stored-byte integrity, not the
correctness of a calculation or continuing freshness of a source dataset.

Every automatically retained answer is labeled `unverified-assistant-claim`.
The context contract explicitly distinguishes recalling a recorded prior answer
from asserting that its calculation was independently verified. A lossy summary
does not make a still-captured answer unavailable.
It records only completion of an assistant turn, not successful completion of a
task. It cannot authorize actions, skip verification, resolve an incident or
grant a retry. Only the existing validated outcome adapter can create a verified
resolution; that path now records the completed resolution ID and next action.
Suspected credentials reject the answer before persistence. Private learning
children, foreign sessions and synthetic summaries do not supply result memory.

Result excerpts are optional context after whole mandatory procedures. Omitted
results must be retrieved explicitly with `alg_memory_read`; no finite pack is
a full conversation backup. Off/observe modes still inject no memory. Off-mode
status remains callable, while disabled operations return an availability notice
and advise against retrying. Public tool IDs remain stable.

## Verification scope

`tests/model-agnostic-recovery.test.ts` covers finish reasons, whole-turn learning,
100-skill discovery, weak-match exclusion, duplicate intake, lossy compact/restart,
host-event capture, secret exclusion, disabled tools and host cancellation. It is
included in `bun run check:session-memory <external-evidence-directory>`.
Live readiness diagnostics retain a redacted structured error cause and stage.
An earlier startup fetch failure remains unattributed; better diagnostics are
not proof its underlying cause is fixed. Live model probes are compatibility
checks, not proof of universal model support or final provider-prompt delivery.
