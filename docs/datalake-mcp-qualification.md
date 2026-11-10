# V1 Investigation MCP qualification CLI

This operator CLI gathers bounded observations for a future Investigation adapter. It uses the repository's pinned `@modelcontextprotocol/sdk` over Streamable HTTP. It does not qualify a service, create an approved profile, or change runtime configuration. An unavailable or air-gapped service produces no synthetic pass.

## Inventory mode

Inventory performs MCP initialization and reads one bounded `tools/list` page. It never calls a tool. If the server returns a pagination cursor, the receipt marks the inventory as first-page-only. Tool descriptions, raw schemas, credentials, and response bodies are not written to the receipt; each tool is represented by its name and the SHA-256 of the canonical input/output schema pair used by the existing profile contract. The endpoint is restricted to HTTPS, or HTTP on loopback for local fixtures. Redirects are rejected. Each HTTP response has a byte cap and requests have a timeout.

```sh
MCP_TOKEN='...' bun run scripts/qualify-investigation.ts \
  --mode inventory \
  --endpoint https://datalake.example.internal/mcp \
  --token-env MCP_TOKEN \
  --timeout-ms 15000 \
  --response-limit-bytes 65536 \
  --output ./qualification-inventory.json
```

`--token-env` is an environment-variable name, never a credential value. Omit it for services that do not require a bearer credential. The endpoint is not retained beyond its origin (scheme, host, and port). Inventory reports MCP initialize identity and tool schema identities; it cannot establish read scope, execution limits, idempotency, result validity, retention, or cancellation.

## Probe mode

Probe requires an explicit JSON configuration that conforms to the existing `InvestigationAdapterSchema`; it does not create or activate that configuration. Existing profile options provide the endpoint, credential environment reference, timeout, response bound, expected MCP identity, tool schema hashes, and fixed execution limits. The config file is limited to 64 KiB. Use a synthetic service/fixture or an operator-approved service route that guarantees the marked synthetic request cannot access production data.

```sh
MCP_TOKEN='fixture-only' bun run scripts/qualify-investigation.ts \
  --mode probe \
  --config ./operator-supplied-profile.json \
  --project-id qualification-fixture \
  --output ./qualification-probe.json
```

Probe creates a one-admission `InvestigationStore` ledger in the recorded `probe_state.directory` and dispatches exactly one request with `{ "qualification_probe": true, "synthetic": true, "rows": 1 }` under the profile's first permitted operation. It then calls lookup with that admitted work's same submission ID. If a typed result is returned, it calls the configured result validator with the admitted work identity and checks the returned validity key and access scope. The ledger directory is retained; the receipt records its directory and, once admitted, the submission ID and work key, plus any observed external job ID. Keep the directory and use those identifiers for later lookup or cancellation if the job is pending or its outcome is unknown. Job IDs, result manifests, source versions, query results, credential values, and tool descriptions are not copied to the receipt beyond the explicit probe-state identifiers. Probe never retries or resubmits. It does not call cancellation or depend on `readResult`.

The receipt reports individual observed checks, failures, and unverified checks. A successful lookup demonstrates only the observed lookup response for that submission ID. It does not establish duplicate-submission idempotency. Profile declarations and schema agreement are not evidence that the server enforces project scope or execution limits. Retention, cancellation behavior, server-side enforcement, and duplicate-submit idempotency remain explicitly unverified until separately exercised under an appropriate controlled qualification procedure. Every receipt has `qualification: "not_established"`; no receipt is an approved/ready profile and nothing is auto-activated.

The exported `runInventory`, `runProbe`, bounded fetch factory, receipt type, and receipt writer support controlled fixtures and focused tests. Probe accepts an injected Investigation MCP port for unavailable-service and contract-failure tests. Do not use an injected port's declared capabilities as evidence of server behavior.

## Receipt handling

Choose a local output path with appropriate access controls. Receipts contain service host and MCP identity plus tool/schema hashes, but no raw schemas or credentials. The writer caps serialized output at 256 KiB. The receipt is evidence of what this CLI observed at a time; it does not populate `investigation.adapter`, change an approval state, or replace operator review of untested guarantees.

Probe journals are retained in the receipt’s `probe_state.directory`, including submission identity before dispatch. Keep that directory for later lookup or cancellation if a job is pending or its outcome is unknown. Receipt output must be a new path; the CLI will not overwrite earlier evidence.
