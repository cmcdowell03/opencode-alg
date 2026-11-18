# OpenCode 2 investigation preview

This package exercises ALG investigation recovery on **OpenCode 2.3.2**. The V1
package at the repository root has its own entry points, SDK and host range.
Build this preview in a checkout based on V1 candidate `6de71d3` or its
descendants.

## Build a portable plugin

Use Bun 1.3.14 and npm. From the repository root, install the locked development
dependencies once on a connected build machine, then build into a new directory:

```sh
npm ci --ignore-scripts
npm --prefix packages/v2-preview ci --ignore-scripts
bun packages/v2-preview/build.ts ../alg-v2-preview-bundle
```

The build emits a package directory and prints the SHA-256 of its JavaScript
entry. Copy the whole output directory to the target. The compiled package
includes its runtime dependencies. Use an isolated OpenCode 2 binary, project
and configuration, with their own service, data, database, cache and state
directories. This keeps the existing V1 installation available for rollback.

In the isolated V2 configuration, point to the **directory** that contains the
generated `package.json`. This configuration enables diagnostics:

```json
{
  "plugins": [
    { "package": "/absolute/path/alg-v2-preview-bundle", "options": { "enabled": false } }
  ]
}
```

Open a session in that location and call `alg_investigation` with
`{"action":"diagnostics"}`. Compare its `runtimeSha256` with the build receipt.
Enabling investigation writes additionally requires `enabled: true`, one
configured `approvedJob`, a matching qualified loopback MCP `adapter` and a
restricted checker agent. The [fixture configuration](acceptance/host.ts) and
[synthetic service](acceptance/service.ts) provide a working local example.
The connector profile limits authority to the configured operation, budget,
project and principal.

## Run the recovery scenario

From the repository root, run this command in PowerShell or Bash. Use absolute
paths to the V2 executable, prepared package directory and a new receipt file.
On WSL, keep the checkout and fixture worktrees on the native Linux filesystem.

```sh
bun packages/v2-preview/acceptance/index.ts --host /path/to/opencode --package /path/to/alg-v2-preview-bundle --out /path/to/receipt.json
```

The harness starts the host, provider and synthetic factory service locally.
It exercises a native control and the installed preview and writes separate
observations for each. The checker must cite a page returned for the granted
manifest. The owner can revoke it while the child is still alive. A denied read
must leave the service's read count unchanged.

The owner creates and admits one job, then dispatches it. After a lost
acknowledgment, `reconcile` looks up the original submission. Once the result
is available, `start` creates the checker, `status` reports its bound verdict
and `revoke` withdraws its result access. To change the next measurement, send
`set_next_measurement` with `next_action` and the `expected_decision_revision`
from the latest status. A stale revision is refused.

## Local qualification

The same two-file package passed on Windows x64 and Linux x64 under WSL on
November 18, 2026. Each installed OpenCode 2.3.2 host passed four native
control checks and twelve preview checks. After a forced process kill, the
restarted session recovered the single accepted job by its original ID. One
fresh checker read 16 rows and cited its page. A neutral user turn returned
the corrected measurement using a value from that page while the stale
compaction summary was still present. Both a foreign project and a revoked
checker were denied without another service read.

Each platform also passed 15 focused tests and an isolated OpenCode 1.19.5
coexistence run with two restarts. The [qualification receipt](evidence/recovery-2.3.2.json)
records the executable, package and raw-receipt hashes. The provider was
scripted and the factory service synthetic. Automatic background compaction,
long-session endurance and real-model decision quality remain unmeasured.

## Scope

The first scenario covers one owner, one accepted external investigation job
and a fresh checker. The existing investigation ledger is authoritative for the
work and result. The host session and original prompt identify the checker.
The next primary request must use the current decision after compaction and
restart. A missing external acknowledgment requires lookup by the original
submission identity. A conflicting, revoked or unresolved result cannot certify
a conclusion.

Full V2 DAG execution, historical skill mining and the TUI remain later stages
of the [migration design](../../docs/opencode-v2-design.md).
