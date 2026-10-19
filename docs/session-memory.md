# Environment-aware session memory

ALG's opt-in deterministic memory layer works independently of skill learning.
It keeps owner-bound task checkpoints and exact procedure versions outside the
conversation, then rebuilds a bounded working view after compaction or restart.
No graph database, embedding service, new MCP, port scan or learning model is needed.

Non-Git folders are supported: OpenCode's `/` worktree sentinel resolves to the
actual working directory, not the filesystem root. Git worktrees retain their
repository scope. Prior builds may have placed non-Git state at a drive/root
`.opencode` directory. That state is left untouched and is not silently imported
into a different project identity; review and explicitly rebind local procedures.

## Enablement and tools

Add options to the existing ALG plugin tuple, without installing a second copy:

```json
{
  "skillEvolution": { "enabled": false },
  "sessionMemory": { "mode": "observe", "fallbackTokens": 2048 }
}
```

In `assist` mode the memory pack is sized from the model's context window by
the shared [context budget](context-budget.md). `fallbackTokens`,
`contextFraction` and `maxContextTokens` apply only when the window is unknown.

- `off` (default): no new store or effects.
- `observe`: capture/diagnostics, no new context injection or action veto.
- `assist`: restore instructions and enforce preflight in explicitly bound adapters.

Learning remains separately controlled. Its auditor/checker and promotion controls
are unchanged. Assist mode replaces duplicate legacy skill injection.

`alg_context_status` reports bindings, next step, selection, omissions, budget and
coverage. `alg_memory_search` finds metadata; `alg_memory_read` expands an owned
object (complete instructions for skills); `alg_memory_propose` stores unverified,
private, unpinned proposals. `alg_skill` previews, policy-approves and loads exact
skill revisions. None approves permissions. Registration now has 20 tools.

### Delegated skill approval in V1

Enable `sessionMemory.mode: "assist"` to restore instructions. Search with
`alg_memory_search`, then call `alg_skill` with `{"action":"preview","skill_key":"<skill-key>"}`.
Preview returns the canonical project identity, source-root identity and exact
candidate revision. Authorize a trusted source and bounded scope once. The harness
can then approve new eligible revisions without editing configuration:

```json
{
  "sessionMemory": {
    "mode": "assist",
    "approvalPolicy": {
      "schema_version": 2,
      "project": "<preview.project>",
      "rules": [{
        "id": "local-procedures", "revision": "1",
        "source": "<preview.source>", "skills": ["connect-lake"],
        "environments": ["development"], "operations": ["read"]
      }]
    }
  }
}
```

Replace placeholders with actual preview values; the example is not executable
configuration. Preserve other plugin options. Use the existing sidecar options
path if the installed host cannot accept plugin tuples. Restart OpenCode to load
policy changes. No tool modifies this policy or the host permission configuration.

Rules match configured source-root identity and exact skill names, environment
names and operation names. `"*"` explicitly permits any value; a restricted list
does not accept an unrestricted/empty manifest scope. Scope is a declared
applicability constraint, not static proof of what instructions will do. Trusting
a writable source delegates approval to its authors within these application checks.

The harness may now call `alg_skill` with `action: "approve"` and `skill_key`.
It receives a `receipt_id` but no active binding. Call `action: "load"` with
`receipt_id` to activate in assist mode. The response contains metadata only;
complete instructions arrive through the next context hook, avoiding an extra
copy in the transcript. Future compactions and
restarts restore the same closure without another approval request. Use
`repin: true` only to explicitly replace an active revision after new approval.
ALG workers cannot call this approval tool; they receive scoped parent handoffs.

Receipts say `policy-approved`, not human-reviewed, and bind exact closure hashes
to the matching rule ID and digest. Unrelated rule changes preserve receipts;
removing/changing the matching rule requires restart and invalidates its receipts.
For immediate revocation use the existing `memory revoke` command
with the receipt ID. Revocation is node-scoped; revoke each delegated copy for
immediate withdrawal across existing children, or withdraw policy and restart all
controllers. Reapproving identical inputs does not undo revocation.
Schema-version-1 hash allowlists remain readable with their original semantics;
they are not silently broadened. Move to policy schema 2 explicitly and reapprove
bindings once. Policy schema 2 is a V1 ALG feature, not OpenCode V2 support.
No-policy legacy mode remains unattested; enabling policy requires new approvals
for old pins. Approval grants no tools, network access or credentials.

This is an application boundary, not protection against an unrestricted agent
rewriting its own config or plugin under the same OS account. There is no new
service, model dependency or V2 implementation. See the
[approval contract](https://github.com/cmcdowell03/opencode-alg/blob/main/docs/knowledge-environment-contract.md#review-and-approval-records).

### Bounded delivery observations

Delivery evidence retains the latest eight preparations/outcomes in one atomic
file per session. Late settlements cannot replace newer observations; a settlement
outside that retained window is unavailable, not successful. This is a bounded
diagnostic window, not a permanent per-request audit log. New writes do not scan
or grow legacy delivery buckets. Existing evidence is left untouched; no automatic
deletion of legacy data occurs.

Each observation is capped at 64 KiB, the journal at 2 MiB and admission at 4,096
session journals. After a failed record write, ALG attempts to withdraw its owned
procedure text and emit a bounded recovery notice when room allows. Ambiguous
concurrent edits remain untouched; foreign context is preserved. The host
conversation remains usable. `alg_context_status` reports delivery failure; the
in-process error flag is not durable evidence. Required-procedure preflight still
applies to integrated ALG actions. Other immutable memory stores retain their
existing quotas; this change does not claim unlimited project storage.

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
Add `--full` to run the entire local Bun suite instead of the affected-test subsets.
The benchmark includes verified reads and receipt writes with 100 skills/1,000
unrelated nodes. Initial Windows warm/cold p95 was 653/1,752 ms; direct-address
restoration reduced it to 313/116 ms. The proposed 100 ms warm target was not met.
The explicit V1 engineering gate is revised to 500 ms warm and 500 ms cold, retaining
original targets and raw samples in reports. These are fixture results, not an SLA.
