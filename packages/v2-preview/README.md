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

## Initial recovery qualification (preview.1)

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
records the executable, package and raw-receipt hashes. This scenario used a
scripted provider, forced compaction and a synthetic factory service.

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

## Research investigations in preview.2

On OpenCode 2.3.2 the same bundle passed the installed recovery scenario on
Windows and Linux. The paired scripted benchmark observed automatic background
compaction on both platforms. An attempted live Luna pair stopped at the
response observer before either arm produced an answer. The
[research qualification receipt](evidence/research-2.3.2.json) records the
observations and limitations.

**Procedure selection.** A location can nominate one approved research procedure.
Set `approvedProcedure` to a project-relative approval JSON under `.opencode/`
and `approvedProcedureSha256` to the SHA-256 of that file's exact bytes in the
operator's plugin configuration. The approval JSON contains the host catalog
`id`, project-relative `path` to `SKILL.md`, SHA-256 of the resolved UTF-8
body in `sha256`, and SHA-256 of the original file bytes in `sourceSha256`.
Read the catalog for the actual location when preparing the pin. Keep the host
watcher enabled so source-precedence changes are visible. For a deployment
which requires ALG approval, configure native `skill` permissions so agents
cannot independently load this procedure.

ALG checks the current source when committing the next decision and when
granting a checker access. It can restore the verified body on the next primary
turn. Delete the approval document to withdraw it. A replacement must match a
new operator pin. Previously delivered text remains part of the conversation.
Fresh authority checks govern subsequent ALG actions.

**Recording a correction.** On `set_next_measurement`, an owner can include
`refutation` with a stable `id`, the hypothesis `statement`, and the existing
work's `manifest_digest`. ALG commits that hypothesis as refuted in the same
revision as the next action. This records who interpreted which evidence. A
checker verdict has its own grant and citation.

**Independent research.** Configure one or two `researchRoles` in the plugin
options. Each has a distinct subagent `agent` and `question`. The owner needs
the `alg_research` permission and each researcher must have an effective
deny-all tool policy. After a result is recorded, the owner's
`alg_research({"action":"start"})` reserves one batch and starts its researchers.
`status` returns their advisory answers. A repeated start inspects the existing
batch. Missing or ambiguous admissions cannot dispatch another external job.
By default researchers receive settled manifest metadata. To share bounded
aggregate counts, set `researchEvidence: { "cohorts": true }` and publish
up to eight distinct `{id, inspected, defects}` records in `coverage.cohorts`.
The checker remains the only role that can certify its granted result.

**Team handoff across repositories.** Use the native OpenCode `references`
configuration to give teammates the same aliases for their local Git checkouts
or configured Git references. In the existing `.opencode/ALG.workspace.json`,
declare sources per operation, for example:

```json
{
  "schema_version": 1,
  "operations": [{
    "id": "compare-inspections",
    "authoritative_sources": [{
      "ref": "reference:contracts/inspection.md",
      "revision": "<sha256 of the committed document bytes>"
    }]
  }]
}
```

Pin the registry bytes with the `teamSourcesRegistrySha256` plugin option.
An owner with `alg_team_source` permission can list the sources for an
operation and request a specific `source`. The read also requires host
`read` and `external_directory` permissions. Cite the returned Git commit,
blob and SHA-256. The alias must point to a Git checkout root; the read accepts
a regular UTF-8 document up to 8 KiB. Uncommitted changes cannot change the
bytes returned for a citation.

## Paired Build and ALG benchmark

Run the same installed OpenCode 2.3.2 binary and the same synthetic investigation
for each arm, with a fresh output filename:

```sh
bun packages/v2-preview/benchmark/run.ts --host /path/to/opencode --package /path/to/bundle --out /path/to/pair.json
```

The default transport is scripted. Its purpose is to qualify the apparatus:
the actual host, tool calls, correctly joined data, independent evidence,
compaction ordering and retained decisions. Only an actual-model comparison
can measure whether the model makes better decisions with ALG. Use
`--help` for the explicit model and context settings. Keep the same case,
provider, model and evidence access in both arms. Include the near-miss case
in evaluations: a chamber association by itself cannot establish a cause.

Use `--variant negative --order alg-first` to exercise that held-out case and
reverse the arm order. For a single live pair, append
`--native-model openai/gpt-6-luna --allow-model-calls` to the command above.
Both arms use the selected model through the host's native OpenAI OAuth
integration. The runner stages an access-only copy of the existing login in
the operating system's temporary directory and removes it after the trial.
The default login source is the OpenCode data directory's `auth.json`;
`--auth-file` can select an existing OpenCode OAuth file.

The observer permits at most 24 requests per arm and records provider-reported
usage. It reserves 1,024 output tokens per outstanding request against a
12,000-output-token per-arm threshold. OpenCode's OAuth transport reports
usage after generation, so an in-flight response can exceed its reservation.
The receipt records incomplete usage and missing race evidence explicitly.
Compare observed correctness independently of native skill activation, ledger
readback, and the automatic-compaction checks.

The [Code Mode example](code-mode.md) shows how to reduce a bounded MCP batch
inside the native host and return a cited aggregate.
