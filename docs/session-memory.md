# Environment-aware session memory

ALG's opt-in deterministic memory layer works independently of skill learning.
It keeps owner-bound task checkpoints and exact procedure versions outside the
conversation, then rebuilds a bounded working view after compaction or restart.
No graph database, embedding service, new MCP, port scan or learning model is needed.

## Enablement and tools

Add options to the existing ALG plugin tuple, without installing a second copy:

```json
{
  "skillEvolution": { "enabled": false },
  "sessionMemory": { "mode": "observe", "fallbackTokens": 2048 }
}
```

- `off` (default): no new store or effects.
- `observe`: capture/diagnostics, no new context injection or action veto.
- `assist`: restore instructions and enforce preflight in explicitly bound adapters.

Learning remains separately controlled. Its auditor/checker and promotion controls
are unchanged. Assist mode replaces duplicate legacy skill injection.

`alg_context_status` reports bindings, next step, selection, omissions, budget and
coverage. `alg_memory_search` finds metadata; `alg_memory_read` expands an owned
object (complete instructions for skills); `alg_memory_propose` stores unverified,
private, unpinned proposals. None approves permissions. Registration now has 19 tools.

## Explicit operator workflow

Run from the plugin package with an absolute project path and exact OpenCode session ID:

```powershell
bun run memory status D:/projects/example ses_example
bun run memory search D:/projects/example ses_example "connect-lake"
bun run memory task D:/projects/example ses_example D:/review/task.json
bun run memory environment-publish D:/projects/example ses_example D:/review/environment.json
bun run memory environment-select D:/projects/example ses_example <profile-id>
bun run memory bind D:/projects/example ses_example <skill-key>
bun run memory progress D:/projects/example ses_example D:/review/progress.json
```

Task request: `{"goal":"Analyze the synthetic lake","constraints":["Read-only"]}`.
Progress request: `{"completed":["connection-check"],"next_step":"Validate grain"}`.
Starting a task clears old procedures, pins, retries and progress. Environment
selection persists until explicitly changed; a switch clears dependent bindings.

Also supported: `repin`, `unbind`, `environment-clear`, `pin`, `unpin`,
`import-evidence`, `import-incident`, `import-legacy`, `resolve`, `retry`, `revoke`,
`delete`, `refresh`. Repinning adopts changed complete bytes after review.
Deletion creates a tombstone, not an erasure of immutable evidence. Legacy import
verifies current source hashes and leaves the old store unchanged.

For custom roots, prepend `--options D:/review/alg-options.json` containing the
same plugin option object. CLI review is explicit even with automatic memory off;
it does not enable the host plugin. These commands express operator intent, not
cryptographic proof of human review. Filesystem/host permissions are the boundary.

### Environment profiles

Profiles use strict JSON:

```json
{
  "name":"lake-pc", "origin":"workstation", "origin_fingerprint":"<status.origin.id>",
  "target":"test-api", "kind":"api", "namespace":null, "tenant":"test-tenant",
  "principal_ref":"reader-role", "protocol":"https", "api_version":"v1", "client_version":"reviewed-client",
  "endpoint_refs":["catalog-endpoint"], "route_refs":["approved-route"],
  "tools":["alg_execute"], "credential_refs":["credential-provider-reference"], "scopes":["read-only"],
  "verified_at":"2026-09-20T12:00:00Z", "expires_at":"2026-09-20T13:00:00Z",
  "source_ref":"<64-character SHA-256 of reviewed source receipt>"
}
```

Supply current timestamps and actual hashes, not these placeholders. Expiry must
be the earliest expiry of identity, routes, capabilities or credential references.
V1 renews the whole profile, not fields independently. No tokens, mounted
credentials, full environment dumps or credential-bearing URLs belong in memory.
References identify a permitted credential provider; they do not grant access.

The passive fingerprint uses local host/platform and container/Kubernetes signals.
It detects mismatches, not authenticated workload identity or network reachability.
Changed origin or expired profile blocks restoration. Recreated workloads with
identical signals still need normal identity/permission validation. Published
profiles are project-visible; tasks, attempts and resolutions stay session-private.
Private-resolution publication is not part of V1.

### Complete procedures

`SKILL.md` stays atomic. Optional `ALG.json` declares dependencies/applicability:

```json
{
  "schema_version":1,
  "requires":[{"path":"route.md","sha256":"<exact file SHA-256>"}],
  "environments":["lake-pc"],
  "operations":["alg_execute"]
}
```

At most eight explicitly declared prerequisites are followed, not arbitrary links.
Bodies, prerequisites and manifests are pinned together. Missing, changed, revoked
or suspected-secret content blocks restoration, without rewriting instructions.
Author separate complete skills with shared prerequisites when procedures are too
large. Automatic splitting and manifest-level module selection are not implemented.

Discovery supports 10,000 metadata entries, a two-second/eight-MiB scan bound and
pages up to 64. Rejections, incomplete discovery and cursors are visible. The
disposable index is in-process. Existing bindings restore directly from configured
sources, without a full catalog scan after restart.

Duplicate skill names or incomplete discovery cannot silently choose an automatic
source. A durable gap requests an exact-key binding; successful explicit binding
clears that gap. Existing reviewed bindings remain source-specific after restart.

## Context and repeat-work prevention

The graph stays on disk. Context receives orientation, complete active procedures
and scoped evidence, marked untrusted rather than executable instructions. Graph
traversal is bounded to two hops, 24 nodes and 48 edges.

Default budget: 8,192 accounting units and 10% of declared context, reduced by
input/response/tool reserves. Unknown full host usage falls back to 2,048 units
(configurable up to 4,096). Accounting uses UTF-8 bytes as a conservative estimate,
not a provider tokenizer or universal token guarantee. Run/evidence recovery and
complete skills share the pack once a task checkpoint exists. Optional evidence
is omitted first; mandatory overflow reports `needs_context`, never a clipped skill.

Run/resume preflight activates when exactly one active skill declares `alg_execute`
and a reviewed environment is selected. Typed non-secret outcome receipts block an
unchanged failed execution on that run. Run and resume share identity, so changing
verbs is not an escape. No command, goal, tool output or credential digest enters
deduplication. Changed execution settings/environment/reviewed procedure change identity.

`retry` takes a JSON request with `operation`, `reason`, `expires_at`. Copy the exact
operation from the attempt payload. The allowance expires within one hour and is
consumed before one execution, including if that execution crashes. Adapter-assigned
polling and verification are allowed; model arguments cannot choose bypass purposes.
Normal host/shell permissions are still enforced independently.

`resolve` takes `operation`, `verification` (imported evidence-node ID), `next_step`,
`expires_at`. A fresh successful outcome must have a `tests` relation and identify
the recorded attempt's source receipt. A bare success or model-authored “done” is
insufficient. `import-incident` imports verification from a currently resolved
troubleshooter incident. This is an explicit snapshot, not a subscription; revoke
or revalidate when conditions change and use bounded expiry.

Workers receive a scoped ticket and procedures before their SDK prompt. Checkers
receive task constraints/environment but no worker private evidence or procedure
bindings. No credentials or transcripts are copied.

## Storage and verified boundaries

`.opencode/session-memory/` contains immutable objects, skill artifacts, checkpoints,
atomic owner-bound heads, registry and preparation receipts. Mutex/fencing and
revision CAS publish objects before heads. Hashes, schemas, owner/project and direct
file paths are checked on reload. Interrupted publication leaves the previous head.
Capacity exhaustion stops writes without silently evicting records.

Synthetic SDK tests verify our callbacks, appended chunks, cancellation and handoff.
Actual OpenCode provider delivery and autocontinue ordering remain **NOT_ATTESTED**.
There is no autocontinue veto or universal tool interception. Generic bash/arbitrary
MCPs are outside enforcement coverage. Replay is best-effort, not lossless archiving.

Run `bun run check:session-memory <absolute-existing-evidence-directory>` for the
source-bound synthetic/type/package gate. No production services or paid models run.
The benchmark includes verified reads and receipt writes with 100 skills/1,000
unrelated nodes. Initial Windows warm/cold p95 was 653/1,752 ms; direct-address
restoration reduced it to 313/116 ms. The proposed 100 ms warm target was not met.
The explicit V1 engineering gate is revised to 500 ms warm and 500 ms cold, retaining
original targets and raw samples in reports. These are fixture results, not an SLA.
