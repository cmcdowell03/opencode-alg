# V1 isolated OpenCode headless acceptance

`scripts/test-v1-headless.ts` runs an isolated, local acceptance against an installed OpenCode 1.x host. It starts a loopback-only OpenAI-compatible synthetic provider, a loopback-only MCP service built with the pinned official SDK, and three short-lived OpenCode servers. The same session is created, exercised, compacted, and recovered after two server restarts. It makes no calls to a hosted model and inherits no configured provider credentials.

## Run

Use Bun 1.3 or newer and an installed OpenCode version `>=1.18.0 <2.0.0`. The harness accepts either the host binary on `PATH` or an explicit absolute binary path.

Windows PowerShell:

```powershell
$env:OPENCODE_BIN = 'C:\path\to\opencode.exe'
bun run scripts/test-v1-headless.ts
```

Linux (including WSL):

```sh
OPENCODE_BIN=/absolute/path/to/opencode bun run scripts/test-v1-headless.ts
```

The process prints one JSON summary and exits nonzero if any required host observation fails. To choose a durable evidence file, pass an absolute unused path:

```sh
bun run scripts/test-v1-headless.ts --output /absolute/path/headless-evidence.json
```

Evidence defaults to a new JSON file under the system temporary directory’s `opencode-alg-v1-headless-evidence` folder. Evidence is written before the harness removes its unique temporary environment. The receipt records the host version and executable, source digest, server process IDs and restart count, loaded tool registry, actual tool calls, compacted transcript recovery, session-memory result pin, provider request observations, real-user config snapshot comparison, and cleanup outcomes. The file is bounded and contains no raw prompts or environment values.

## What this checks

- The installed host starts with the current package plugin and exposes the complete ALG tool registry.
- A real host session invokes `alg_context_status`, calls `alg_plan` with the fixed `data-investigation` template, and then calls the actual `alg_investigation query` route.
- The host query uses `InvestigationHttpPort` and the pinned synthetic profile. Its loopback MCP service checks server identity, exact schemas, read-only operation, principal, project scope, and fixed execution limits before accepting the bounded fixture request.
- Three completed query tool results, separated by compaction and two restarts, must retain one work key, manifest reference, and digest. The service receipts must show exactly one submit call and accepted remote job, with fresh result validation after both restarts.
- The session-memory hook stores a result node and checkpoint pin before compaction.
- OpenCode’s summarize route compacts the transcript using only the synthetic local provider; the host transcript contains the reference and result markers.
- Two server restarts preserve the same session ID, compacted summary, result pin, and attached investigation; each resumed model turn invokes the same query and receives its revalidated result.
- Both local services and OpenCode bind to loopback; the child environment contains no known provider credential variables; global OpenCode configuration snapshots match before and after.

Workspace runs in optional `observe` mode; this does not claim mandatory-operation profile or enforcement coverage. The fixed plan is created, but no worker graph is run. The MCP endpoint is a deterministic local fixture using the official SDK, not a production service; its synthetic profile qualifies only this bounded test contract. The model output is deterministic synthetic text. Passing is host integration evidence, not evidence about model quality, production provider behavior, real-user credentials, external service qualification, or deployment packaging.

The package runtime files are copied into the harness-owned temporary root and their source digest is recomputed before launch. OpenCode loads that immutable snapshot for all three server processes, so a concurrent checkout edit cannot change the loaded code after source identity is recorded. The temporary source snapshot and project are removed only after evidence is persisted.

The configured model package uses OpenCode’s OpenAI-compatible provider support. See the [OpenCode server API](https://docs.opencode.ai/server/) and [provider configuration](https://opencode.ai/docs/providers/) for host API and provider behavior.
