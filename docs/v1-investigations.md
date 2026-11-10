# V1 workspace readiness and durable investigations

This experimental candidate implements the local workspace and durable-investigation contracts of the first phase of the [V1 design](alg-v1-design-index.md). Synthetic full-graph and installed-host recovery checks are recorded in [implementation status](v1-implementation-status.md). The real air-gapped datalake-mcp remains unqualified; a local-model graph completed, but its enclosing session timed out after starting redundant work. Workspace requirements, a fixed investigation graph and a durable query ledger reuse ALG's existing skill approval, run ownership, node schemas, retries, checkpoints and context budget. All features are model independent. OpenCode 2, autonomous graph changes and measured skill promotion remain later work.

## Enable deliberately

Use the existing plugin options or deployment sidecar. Session memory must be in `assist` mode for investigations; set `investigation.enabled: true`. Set `workspace.mode` to `observe` for diagnostics or `assist` for procedural context and configured enforcement. All new behavior defaults off. Do not place credentials in repository JSON, skills, checkpoints or model arguments. The remote adapter accepts an environment-variable name for its credential reference.

Put project requirements in `.opencode/ALG.workspace.json` using `WorkspaceRegistrySchema` in `src/workspace/schema.ts`. An operation lists its phases, roles, environments, resource IDs and skill/document/fact requirements. A missing registry, missing facts, conflicting evidence or incompatible scope stays visible through `alg_context_status`; it is not assumed ready. The host resolves only requested facts from bounded local sources, including repository identity/remotes, the declared `package.json` test script, platform, and bounded document hashes. Unsupported or unavailable facts remain unknown; the registry cannot assert its own truth. The before-tool hook recognizes only explicit simple Git/test commands and records their operation; it does not infer compound commands or grant execution authority. Readiness for ordinary commands remains advisory.

The registry describes requirements but cannot grant permissions. To require a procedure at the managed investigation boundary, operator configuration pins the exact registry byte SHA-256 in `workspace.trustedRegistryHash` and includes `data.investigate.read` in `workspace.mandatoryOperations`. The corresponding operation must declare qualified coverage and the `alg_investigation` boundary. Use the `execute` phase for this boundary. Use input_validator: investigation-work-v1 and resource_resolver: investigation-project-v1, the implemented adapter identifiers. The managed path accepts read/discovery/submission effects, not writes.

Skill selection uses exact names and the existing skill approval policy. Approved complete instructions are restored through session memory. Source drift, ambiguous names, revoked policy or an incompatible environment prevents automatic selection. Loading a newly needed procedure returns `needs_context`, allowing another model step to read it before dispatch. No automatic source repinning occurs. Requirements outside a covered adapter are advisory: ALG does not intercept every shell command or arbitrary MCP call.

## Qualify datalake-mcp

`investigation.adapter` describes one operator-qualified MCP service contract. It pins the server revision, authenticated principal, allowed operations, exact input/output schema hashes, profile expiry and evidence reference. Record verifierId, evidenceSha256 and verifiedAt from the actual operator qualification receipt; the workspace operation must name that verifier in verifier_ids. The transport uses the official MCP client over Streamable HTTP. HTTPS is required except for local loopback tests. Redirects, changed schemas, expired profiles, oversized responses and unexpected output envelopes fail closed. A capability profile records the operator's verified contract; schema matching alone does not prove server behavior.

The transport accepts trusted, operator-configured declarative mappings from the internal request to native MCP arguments and from native responses into the internal envelope. Mappings support bounded JSON pointers into request/host values, nested output fields, explicit constants, and up to eight response cases selected by a reviewed discriminator. The mapping is local trusted configuration; model requests cannot supply or change it. Fixed reviewed recipes bind operation/version and bounded typed parameters; use `admit_recipe`, which constructs the normalized executable query on the host. When `investigation.recipes` is nonempty, admission rejects queries that do not exactly match a configured recipe and its normalized parameters. An empty recipe list retains the earlier explicit `admit` interface for qualified bounded service operations; it does not provide semantic deduplication of arbitrary queries. Configure reviewed recipes for the intended production investigation path.

The real datalake-mcp service still needs qualification. The separately supplied operator qualification CLI can inventory or probe a service when reachable, but it does not itself establish a profile, and a real air-gapped MCP remains **UNQUALIFIED** until its service-specific behavior is independently evidenced. Required guarantees include stable submission idempotency, lookup by submission identity, result validity/access checks, and optionally cancellation. The profile pins MCP initialization identity and tool schema hashes, read-only operations, server-enforced project scope, and maximum duration, scan bytes, result bytes and cost. ALG reserves that configured maximum per admitted job. The service enforces job limits independently of the client connection. Responses contain job IDs or bounded manifests, not bulk Arrow data or Parquet contents. Keep Polars, DuckDB, joins, preprocessing and S3 materialization in datalake-mcp.

Before using a real deployment, exercise duplicate submission, accepted-request/lost-response, expired job lookup, cancellation, permission revocation, retention expiry and changed source versions against that service. Only a lookup contract that proves a submission was never accepted may allow its reservation to be submitted. An ordinary missing job is not sufficient. Local synthetic tests do not qualify an inaccessible air-gapped service.

## Start and resume

Call `alg_plan` with `template: "data-investigation"`, a bounded goal and explicit evidence criteria. The fixed graph discovers metadata, fans out into three bounded analysis branches, reconciles their findings, pauses for engineer review, performs confirmation and runs an independent checker. No recursive orchestrator spawning or model-authored graph is admitted to this managed path. Reuse the existing run and attached investigation when continuing the same work. Explicitly creating a new plan creates a separate investigation; ALG does not infer global equivalence between goals or prevent every redundant plan a model may request.

The orchestrator and its active, scoped children use `alg_investigation`:

- `status` reads the attached ledger and investigation checkpoint.
- `admit_recipe` is orchestrator-only: it accepts a configured operation/version and bounded recipe parameters, records the host-normalized work order, and assigns explicit graph node IDs. The host chooses the service reservation, analysis/checker purpose and generation.
- `query` takes only the recorded work key. Children can execute only orders assigned to their active graph node; they cannot change parameters or admit new searches. A returned result manifest is revalidated for source, access and retention before reuse.
- `read_result` returns bounded evidence pages of at most 100 rows, subject to both a global 16 KiB page-byte cap and the qualified transport profile's response-byte limit. Up to eight pages per result are durably cached by immutable manifest, digest, scope, cursor and row limit. Cached pages are returned only after current source/access/retention revalidation; cache exhaustion requires narrowing the reviewed recipe.
- `reconcile` looks up existing submissions. It does not launch another job.
- `attach` and `detach` are owner-only, explicit lifecycle actions. New tasks detach the session pointer while preserving prior durable work.
- `note` and `hypothesis` let the orchestrator reconcile coverage, contradictions, completed tests, evidence references and the next action. Child findings remain in their existing node outputs.
- `cancel` records cancellation intent. An acknowledgement does not release the reservation until termination is established.

An optional analytical_result checkpoint records supported, contradicted, unresolved or blocked, with a claim and evidence references. It is explicitly reported_analysis. Keep this separate from the run status and incident remediation; neither a checker pass nor repetition promotes a claim to verified causality.

The host performs bounded continuation inside the existing tool/executor call: default 30 seconds, operator-configurable to at most 15 minutes. This is not a daemon. When the wait expires or the host process stops, the durable job remains and an explicit `alg_run`/`alg_resume` or reconciliation is required after restart; unknown outcomes are not resubmitted. Each lookup is durably counted and capped at 1,000 per work item.

The ledger lives under `.opencode/runs/<run_id>/investigation/`. Immutable snapshots, an integrity-checked committed head, filesystem locking and fencing prevent stale callbacks from overwriting newer outcomes. Work identity includes the project, remote principal/service/tool revisions, executable query, source dependencies and declared analysis purpose. Independent verification has a distinct host-selected purpose when the orchestrator assigns an order exclusively to a checker node. Model-selected refresh/recomputation and generation changes are unsupported. ISO as-of dates and timezone-qualified timestamps are normalized to UTC; ambiguous dates are rejected. Descriptive parameters not sent to the service do not change execution identity. Configured recipes normalize their declared typed parameters; arbitrary query equivalence and undeclared domain-specific normalization remain outside the guarantee.

Reservation amounts use at most six decimal places and are accounted in integer millionths. Finer-precision service billing remains exact on the work receipt; the cumulative budget charge rounds upward to the next millionth, so terminal evidence is retained without understating spend. A valid terminal cost above its reservation is recorded, the active slot is released, and a durable budget breach blocks new admission/dispatch until the operator reviews the service contract. The result and actual spend are retained even when the total budget was exceeded. Local pre-submission failures and qualified proof of nonacceptance release their reservations at zero cost; unknown remote outcomes do not.

At most two expensive jobs may be active. A finite admission count also bounds zero-cost work. Cumulative cost and outstanding reservations survive compaction, retries, detach and restart. Unknown remote outcomes retain their reservations and block affected progress. A failed child schema does not erase its previously committed data job or a completed sibling's artifacts.

## Typed requests and operator recovery

The tool takes a structured `request` union, not JSON embedded in a string. For example, admit a configured recipe with `{ "request": { "action": "admit_recipe", "operation": "bounded-read", "version": "1", "parameters": {}, "node_ids": ["process"] } }`, then execute with `{ "request": { "action": "query", "work_key": "<returned key>" } }`. The operation/version must already exist in trusted configuration; the example names are illustrative. Argument failures return bounded issue codes and safe field names, without unknown keys or values.

The operator CLI supports `--abandon-work KEY --statement REASON` for unsubmitted or terminal work, `--retry-unaccepted KEY --reserve-cost REVIEWED_MAXIMUM --statement REASON` only after zero-cost nonacceptance is proven, and `--migrate-profile PATH --statement REASON` for an explicitly reviewed qualified-profile change. Migration requires no active jobs and no uncertain remote outcomes; it retains the old work, evidence, receipts and profile history while recording the new profile decision. These actions require the existing project, owner, run and engineer arguments. Recovery records the operator contribution in the same ledger transaction and retains the submission idempotency ID on retry. Neither action can conceal potentially active remote work or erase spent budget. Cancellation still needs terminal confirmation.

Older candidate ledgers remain inspectable/reconcilable, but new admissions to an unversioned identity ledger are blocked rather than risking duplicates under the changed normalization. Candidate 0.5.2 prevents rollback into older 0.5.1 and 0.5.0 readers after writing its new fields. Do not delete an old ledger to bypass that boundary.

## Engineer checkpoint

Before the `confirm` node, the run blocks without spending a confirmation attempt. Review the initial evidence and record an operator decision with:

```sh
bun run scripts/investigation-cli.ts --project "/path/to/project" --owner "session-id" --run "run-id" --engineer "engineer-reference" --statement "Reviewed the initial evidence and its coverage" --scope "initial findings" --proceed
```

Then use `alg_resume`. The receipt binds the reviewed graph, criteria and completed initial findings; changed findings require a new review. Engineer contributions are labelled reported knowledge, not automatically verified causal evidence. The CLI is an application-level approval boundary. A same-account agent with unrestricted shell/filesystem access is not isolated by an OS security boundary; deployments requiring that separation must restrict those permissions externally.

## What survives context loss

The normal request hook and compaction hook reconstruct a bounded view from disk: the investigation reference, current budget, recent job identities/status, hypothesis and contradiction summaries, coverage and the next action. Full ledgers, data and evidence stay outside the prompt. Approved skills retain their existing complete-instruction and delivery checks. Managed query dispatch and run/resume recheck durable authority even when a hook is missed.

Generic run ownership transfer is intentionally rejected for investigations in this phase. Resume the owning session; cross-user transfer requires a separately designed principal and evidence-access transition. Detaching a session does not prove remote compute stopped. Service-enforced deadlines bound orphaned jobs, and later reconciliation records their outcomes.

## Acceptance and deployment

Use the [prepared offline deployment](deployment.md) command for a bundle built for the destination platform. The [Linux/Bash acceptance plan](alg-v1-linux-bash-acceptance-plan.md) defines the matching local Linux and PowerShell lanes. Test receipts identify the exact commit, runtime and dependencies. A server/tool registration check proves loading; synthetic MCP/provider tests prove deterministic integration; neither establishes analytical quality against production data or arbitrary models.

## Reviewed recipe example

Add recipes alongside the existing qualified adapter in plugin options:

```json
{
  "investigation": {
    "enabled": true,
    "recipes": [{
      "operation": "particle-window",
      "version": "v1",
      "base_query": { "recipe": "approved-particle-window" },
      "parameters": [
        { "name": "tool", "type": "enum", "values": ["fixture-tool-a", "fixture-tool-b"], "required": true },
        { "name": "at", "type": "iso_timestamp", "required": true }
      ]
    }]
  }
}
```

This fragment is not a complete or qualified service profile. Replace fixture identities with reviewed service definitions. The orchestrator calls `recipe` to inspect parameter declarations, then `admit_recipe` with the operation, version, parameters and assigned node IDs. Equivalent timezone-qualified timestamps normalize to one instant. No parameter coercion, unrestricted SQL rewriting or model-selected refresh generation occurs.

A native tool binding maps named inputs from `request` or host-owned scope and maps outputs from the native `response`. Use response discriminators for distinct running/result/failure states; unrecognized states stay uncertain. Validation must derive access and freshness from actual service checks. Do not map a constant `valid: true` to substitute for those checks. Likewise, ordinary “job not found” must not be mapped to proof of nonacceptance unless the service's measured retention/idempotency contract guarantees that conclusion.
