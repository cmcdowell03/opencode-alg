# V1 workspace readiness and durable investigations

This implements the first phase of the [V1 design](alg-v1-design-index.md). Workspace requirements, a fixed investigation graph and a durable query ledger reuse ALG's existing skill approval, run ownership, node schemas, retries, checkpoints and context budget. All features are model independent. OpenCode 2, autonomous graph changes and measured skill promotion remain later work.

## Enable deliberately

Use the existing plugin options or deployment sidecar. Session memory must be in `assist` mode for investigations; set `investigation.enabled: true`. Set `workspace.mode` to `observe` for diagnostics or `assist` for procedural context and configured enforcement. All new behavior defaults off. Do not place credentials in repository JSON, skills, checkpoints or model arguments. The remote adapter accepts an environment-variable name for its credential reference.

Put project requirements in `.opencode/ALG.workspace.json` using `WorkspaceRegistrySchema` in `src/workspace/schema.ts`. An operation lists its phases, roles, environments, resource IDs and skill/document/fact requirements. A missing registry, missing facts, conflicting evidence or incompatible scope stays visible through `alg_context_status`; it is not assumed ready. The initial host fact resolver supplies the platform and bounded document hashes. Other facts remain unknown until a real resolver is added; the registry cannot assert its own truth.

The registry describes requirements but cannot grant permissions. To require a procedure at the managed investigation boundary, operator configuration pins the exact registry byte SHA-256 in `workspace.trustedRegistryHash` and includes `data.investigate.read` in `workspace.mandatoryOperations`. The corresponding operation must declare qualified coverage and the `alg_investigation` boundary. Use the `execute` phase for this boundary. Use input_validator: investigation-work-v1 and resource_resolver: investigation-project-v1, the implemented adapter identifiers. The managed path accepts read/discovery/submission effects, not writes.

Skill selection uses exact names and the existing skill approval policy. Approved complete instructions are restored through session memory. Source drift, ambiguous names, revoked policy or an incompatible environment prevents automatic selection. Loading a newly needed procedure returns `needs_context`, allowing another model step to read it before dispatch. No automatic source repinning occurs. Requirements outside a covered adapter are advisory: ALG does not intercept every shell command or arbitrary MCP call.

## Qualify datalake-mcp

`investigation.adapter` describes one operator-qualified MCP service contract. It pins the server revision, authenticated principal, allowed operations, exact input/output schema hashes, profile expiry and evidence reference. Record verifierId, evidenceSha256 and verifiedAt from the actual operator qualification receipt; the workspace operation must name that verifier in verifier_ids. The transport uses the official MCP client over Streamable HTTP. HTTPS is required except for local loopback tests. Redirects, changed schemas, expired profiles, oversized responses and unexpected output envelopes fail closed. A capability profile records the operator's verified contract; schema matching alone does not prove server behavior.

The service must expose submission with stable idempotency IDs, lookup by those IDs, result validity/access checks, and optionally cancellation. The profile also pins the MCP initialization name/version and attests read-only operations and server-enforced project scope. Its executionLimits specify maximum duration, scan bytes, result bytes and cost. ALG reserves that configured maximum cost per admitted job rather than trusting a smaller model-supplied estimate. It must enforce the configured job limits independently of the client connection. Responses contain job IDs or bounded manifests, not bulk Arrow data or Parquet contents. Keep Polars, DuckDB, joins, preprocessing and S3 materialization in datalake-mcp. This adapter does not recreate those capabilities in ALG or assume all FastMCP tools share these semantics.

Before using a real deployment, exercise duplicate submission, accepted-request/lost-response, expired job lookup, cancellation, permission revocation, retention expiry and changed source versions against that service. Only a lookup contract that proves a submission was never accepted may allow its reservation to be submitted. An ordinary missing job is not sufficient. Local synthetic tests do not qualify an inaccessible air-gapped service.

## Start and resume

Call `alg_plan` with `template: "data-investigation"`, a bounded goal and explicit evidence criteria. The fixed graph discovers metadata, fans out into three bounded analysis branches, reconciles their findings, pauses for engineer review, performs confirmation and runs an independent checker. No recursive orchestrator spawning or model-authored graph is admitted to this managed path.

The orchestrator and its active, scoped children use `alg_investigation`:

- `status` reads the attached ledger and investigation checkpoint.
- `query` admits a typed work order, deduplicates it and submits only genuinely new reserved work. Returned cached results require fresh source/access/retention validation.
- `reconcile` looks up existing submissions. It does not launch another job.
- `attach` and `detach` are owner-only, explicit lifecycle actions. New tasks detach the session pointer while preserving prior durable work.
- `note` and `hypothesis` let the orchestrator reconcile coverage, contradictions, completed tests, evidence references and the next action. Child findings remain in their existing node outputs.
- `cancel` records cancellation intent. An acknowledgement does not release the reservation until termination is established.

An optional analytical_result checkpoint records supported, contradicted, unresolved or blocked, with a claim and evidence references. It is explicitly reported_analysis. Keep this separate from the run status and incident remediation; neither a checker pass nor repetition promotes a claim to verified causality.

The ledger lives under `.opencode/runs/<run_id>/investigation/`. Immutable snapshots, an integrity-checked committed head, filesystem locking and fencing prevent stale callbacks from overwriting newer outcomes. Work identity includes the project, remote principal/service/tool revisions, executable query, source dependencies and declared analysis purpose. Independent verification uses a distinct purpose; explicit refresh/recomputation uses a new recorded generation. Do not change generations merely to evade an unknown outcome.

At most two expensive jobs may be active. A finite admission count also bounds zero-cost work. Cumulative cost and outstanding reservations survive compaction, retries, detach and restart. Unknown remote outcomes retain their reservations and block affected progress. A failed child schema does not erase its previously committed data job or a completed sibling's artifacts.

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
