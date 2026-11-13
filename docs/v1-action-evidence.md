# V1 durable action evidence and checker recovery

ALG retains host observations separately from the small execution preview in a
checker prompt. A long command or an earlier attempt can therefore remain
available even when the prompt omits it. This implements the evidence-recovery
follow-up to the L2 benchmark; it does not change or regrade that cohort.

## Authority and storage

The V1 plugin binds a child session to its run, node and attempt before sending
its prompt. For native `bash` calls, the before hook writes an immutable intent;
the after hook writes a linked terminal observation. Other tools are explicitly
outside this capture scope. These records live beneath the existing run's
`artifacts/action-evidence/` directory. They contain permitted, redacted command
and output text, never reasoning transcripts or model-supplied execution claims.
An attempt stores a content-addressed manifest reference, not its full journal.

Existing bounded child-history retrieval can reconcile a missing terminal
observation with the same session and call ID. It cannot infer an intent, claim
complete history, or replay the call. An intent without a terminal remains
unknown. Recovery discovers retained records after a restart; absent legacy
records remain unavailable. Prompt omission, redaction, source truncation and
capture gaps are separate conditions.

The journal is an application-level integrity mechanism within the existing
filesystem permission boundary. An agent with unrestricted filesystem access can
still tamper with local files. Hashes detect changed referenced bytes; they do not
make a claim true or establish remote acceptance. Raw local evidence is not
published with benchmark summaries.

## Checker access

Before launch, the host freezes references from the checker's explicitly related
producer nodes, across retained attempts. Task-contract producer declarations
and existing graph evidence wiring determine that scope. The checker receives a
temporary read capability for `alg_artifact`:

```json
{"evidence":"index"}
```

```json
{"evidence":"read","record_id":"<digest from index>","offset":0}
```

Index pages contain at most 16 references. Reads return at most 8 KiB of source
bytes and an optional next offset. A returned `R<digest>` citation identifies the
exact inspected page, including its source reference and offset. The checker
cannot submit an arbitrary path, authorize its own citation, inspect an unrelated
run, or keep using the grant after its turn. Its original E1–E8 evidence basis
remains unchanged. Read receipts retain hashes and ranges, not duplicate logs.

Up to 64 producer journals and 32 page reads are admitted per checker attempt.
Omissions are explicit. These bounds supplement, and never reset, the existing
step, local-attempt, global-attempt and cumulative task allowances. A page or
manifest pointer alone cannot establish the contents of omitted pages. Persisted
attempt and archive loading verifies source identity, assigned references and
the exact cited slices again.

## Recovery versus repair

A schema-valid verified checker with at least one `inconclusive` finding and no
`unsupported` or `disconfirmed` findings receives `evidence_unavailable`.
ALG may retry that checker within its existing allowance. It does not route
missing evidence back to the implementer, invalidate successful sibling work or
reset budgets. Exhaustion remains an honest failure with durable records.
Legacy untyped verdicts retain their historical routing semantics.

Use `inconclusive` when necessary evidence is missing, conflicting or insufficient
to decide. Use `unsupported` or `disconfirmed` when observations establish an
unmet requirement or defect. Mixed verdicts with an actual defect still follow
the substantive repair route. A completed producer missing native command
evidence is blocked on explicit resume instead of being rerun to manufacture
proof. Compaction keeps the run pointer and recovery instruction; the journal
and outstanding findings remain in durable attempt state.

## Remote work and limitations

A shell command, a printed job ID and an exit code do not prove that a remote
service accepted work exactly once. Managed investigations continue to use the
existing submission ID, qualified transport, durable work ledger and service
lookup/reconciliation contract. This change adds no new remote protocol or
service attestation and never resubmits an unknown outcome for evidence recovery.

V1 hooks are bounded observations, not a comprehensive OS audit. Missing hooks,
failed tools without terminal metadata, unsupported tools, redacted fields and
capture limits remain gaps. No generic mechanism can recover information that
was never captured. Older plugin builds cannot consume the new optional fields
or outcome; keep the upgraded runtime with its newly written run state.

## Qualification

Local tests cover long commands, more than eight actions, earlier attempts,
unknown crash outcomes, history reconciliation, capture limits, scoped reads,
forged or corrupted references, archive reload and checker-only retries.
The headless acceptance harness uses a deterministic local provider with the
actual OpenCode V1 plugin in PowerShell and Linux Bash. It tests mechanics rather
than model reasoning. Results and limitations belong in a separate immutable
evidence receipt; implementation alone does not establish ALG superiority.

No V2 implementation, GitHub runner execution or new paid benchmark cohort is
part of this change.
