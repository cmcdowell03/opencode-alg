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

### Investigation handoff in preview.3

The owner session has one native instruction entry named `alg.v2.owner-brief`.
It carries the current ledger and decision revisions, work status, settled
manifest digest, and the verified approval revision when one exists. Before
model requests ALG checks the live state. It supplies the recorded refutation
and pending measurement as bounded user-role data. The ledger remains the
source of record across restarts. Withdrawing the procedure approval keeps
the cited evidence available and withdraws the procedure-dependent recommendation.
Past turns may still contain information delivered before withdrawal.

To gate an expensive query, set `preQueryPolicy.procedure` to the approved
procedure pin and `preQueryPolicy.prerequisite` to
`{ "kind": "committed_clock_alignment", "revision": "<git commit>", "path": "clock-alignment.json", "sha256": "<content digest>" }`.
The committed JSON sample must cover the exact project, operation, recipe,
cohort, as-of time, source dependencies, and preprocessing revision. ALG checks
a positive row count and maximum skew within the attested tolerance. See the
[complete sample](benchmark/handoff-gate.ts). This verifies a pinned sample;
the operator owns its provenance and tolerance. A later matching request can
reuse the settled manifest. For an uncertain submission the only automatic
operation is lookup by its original identity.

Set `continueOnEvidence: true` to allow an idle investigation owner to be
prompted by a newly verified checker result, completed advisory batch, or
reconciled external result. This can initiate another model turn. External
lookups use a short, finite schedule. Long-running work remains in the ledger
and can be reconciled on a later turn. ALG records the wake before requesting
host admission, so a crash at that boundary can require a manual continuation.
The default is off.

Run the matched post-compaction handoff locally:

```sh
bun packages/v2-preview/benchmark/handoff.ts --host /path/to/opencode --package /path/to/bundle --out /path/to/active.json
bun packages/v2-preview/benchmark/handoff.ts --host /path/to/opencode --package /path/to/bundle --out /path/to/revoked.json --variant revoked --order alg-first
bun packages/v2-preview/acceptance/continuation.ts --host /path/to/opencode --package /path/to/bundle
```

For the full scripted local matrix, use a fresh output directory:

```sh
bun packages/v2-preview/benchmark/qualify-local.ts --host /path/to/opencode --package /path/to/bundle --out /path/to/qualification
```

The matrix checks both arm orders on the near miss and on three-compaction
workloads with active and withdrawn skills. It also qualifies single-compaction
handoffs. Each extended arm interleaves three independently scored tasks with the
investigation. The evaluator records the decision immediately before and after
each actual compaction and checks which summary the provider received. An item
enters the loss denominator only if the earlier decision had the correct value
and the corresponding source evidence. The receipt reports changed obligations
on revocation, unresolved answers, duplicate work and cache reads separately.
The forced schedule measures retention under repeated compaction. It does not
estimate a natural hourly compaction rate.

The [qualification criteria](benchmark/qualification.md) define the live
preview gate and the evidence required to claim a comparative advantage.

Both arms receive the same correction, a real host compaction, and then only
`Continue.`. The receipt separates host mechanics, each arm's standalone
decision, and installed ALG behavior. Use the native-model flags below for a
live pair. Scope usage to the owner and checker. Missing usage or price is
unknown. A host cost estimate and an invoice are different measurements.

In the first live Luna pair, ALG reported eight inspected wafers, seven
defects, three independently verified clock corrections, and the correct next
action to replay the clock join. Build could not establish the inspection
cohort and abstained. ALG used 106,803 total tokens across the owner, checker
and compaction. Build used 53,825. Both arms missed the initial facts.
The live ALG call to dispatch included a field reserved for updating a
decision. The calibration stayed reserved and the expected cited refutation
was missing. The final package returns the accepted arguments for that
action, and a regression exercises the refused call followed by a valid
dispatch. The [validation record](evidence/handoff-2.3.2.json) identifies the
live candidate and the final cross-platform package separately.

With separate discovery and lookup tools, the subsequent ALG-first Luna pair
gave both agents the same correct final decision. Each made three evidence
admissions, recorded one cache hit, and retained all seven eligible report
fields through a verified compaction. Build used 41,652 total tokens and ALG
used 128,563. ALG also completed one separately budgeted calibration and reused
the settled manifest. The frozen preview gate failed. The ledger reached
revision 3 and preserved the refutation, and the benchmark could not verify the
procedure body in the system role. The [paired results](evidence/retention-2.3.2.json)
record the original grades. To independently inspect the acknowledged writes,
manifest, refutation and procedure read for the active single-compaction case,
run `bun packages/v2-preview/benchmark/handoff-audit.ts /path/to/raw-pair.json --review packages/v2-preview/evidence/retention-2.3.2.json`.
This replay makes no model calls. This tuned incident contributes no independent
held-out estimate of an advantage.

The decision grader follows the owner's acknowledged writes in the host
transcript. At each compaction it compares the latest accepted action and
revision with the stored checkpoint and the brief. The checker can deliver
its verified correction through OpenCode before the explicit user turn.
Conflict responses, final-answer prose and a later repair cannot establish
that the correct checkpoint existed at an earlier boundary.

New receipts record `compaction.boundaries[].skillDelivery` for each arm.
Each successful continuation request lists the roles carrying the full pinned
body and the roles carrying ALG's marked approval plus body. Request IDs link
each observation to the root request that received the completed summary
before the answer. `complete: true` with empty roles means the observer found
the body in none of those requests. An incomplete capture leaves that question
open. The Responses observer distinguishes the top-level `instructions` field,
explicit system and developer messages, and tool outputs. A tool read or a
quotation in a user message cannot satisfy the system-projection check.
Older receipts without this capture have unknown delivery roles.

### Orchestrator input in preview.4

The owner receives the current decision, its cited refutation, the next measurement
and the live approved procedure. Its tool schema contains the actions the owner
can call. The checker's schema contains the read, procedure and result actions.
When successful ALG tool results repeat identical provenance, the model can
resolve a reference to the full field in an earlier tool result in the same
request. The same rule keeps the first full procedure read and identifies later
identical bodies by digest while the full approved procedure is in context.
Compaction starts a new window for these references. The durable tool results
still contain the original fields.

On the matched scripted handoff, ALG sent 8,929 fewer bytes on both Windows
and WSL. Each platform's matrix retained all 92 eligible fields per arm.
In the single native Luna pair, ALG used 126,770 input tokens (previously
126,657), and Build used 45,843. After compaction, ALG loaded the skill, read
the procedure and checked status. It gave the correct counts, action and
prerequisite in prose and omitted both evidence references. Build returned
all seven fields in the requested format. The native run missed the acceptance
gate. [Comparison and receipt hashes](evidence/input-usage-2.3.2.json)

### Delivering a recurring report after compaction

Preview.5 preserves an explicitly requested recurring JSON report across the
native OpenCode compaction boundary. Before the host drops the old messages,
ALG records the requested fields and their last reported scalar values in the
owner's investigation journal. It binds the report to the acknowledged
decision, settled work and manifest, procedure approval, and compaction ID.
Source references must occur in earlier tool results or a user's structured
evidence handoff. Counts and other reported values retain their original status
as model observations.

On the first bare `Continue.` after that compaction, the owner can return the
report directly. ALG checks the live binding, supplies the fields as user-role
data, and keeps its readiness instruction separate. A changed decision,
withdrawn procedure, or incomplete report calls for reconciliation or abstention.
A new task takes the normal investigation path. The initial release covers
explicit recurring flat JSON objects with bounded fields and scalar values.

In the capped Luna pair, ALG used all 24 calls before it could answer
`Continue.`. Its corrected report already counted four verified corrections
before compaction. Recomputing the join from the source rows gives three.
Build returned all seven fields correctly in 14 calls. The saved report
passed ALG's citation checks in offline replay. Derived measurements still
need independent verification before they can be treated as facts.
[Delivery qualification results](evidence/report-delivery-2.3.2.json)

### Verifying derived measurements in preview.6

A pinned, approved skill can include one `alg-calculation` JSON fence. It
names the evidence tool, page bounds, row keys, correction source and report
fields. Supported operations are row counts, filtered counts and filtered
counts of rows matching a composite key in a second source. The host runs the
recipe against completed tool results from the owner and a structured user
handoff. It exposes computed values and their source references to the owner
without another search. The [synthetic clock skill](benchmark/handoff-case.ts)
shows a complete recipe.

At compaction ALG saves the calculation with the report, including the recipe
digest, source message identities, row counts and row digests. On continuation
it checks the current binding and compares the requested numeric fields with
the computed values. A disagreement withholds the ready report and returns the
calculation so the owner can revise the report and its recommendation. A
missing recipe, source or calculation for a requested number requires further
evidence. Older numeric reports follow this same rule.

The investigation tool also narrows its advertised actions and arguments as
work advances. For example, a reserved job exposes dispatch, a running job
exposes reconciliation, and a settled manifest permits starting a checker.
The registered execution contract still enforces permissions, revisions and
exact retry behavior for direct calls.

On OpenCode 2.3.2, Windows and WSL each passed 176 tests, six installed delivery
cases and eight scripted pairs with the same preview.6 bundle. In one native
Luna pair, Build returned all seven fields correctly in 15 requests and 43,929
input tokens. ALG used 22 requests and 116,181 input tokens. It stopped at
four inspection rows with three defects, below the required four defects.
The host withheld the calculated values. Luna still reported one verified
correction before and after compaction. Build read the next permitted window
and found eight rows, seven defects and three verified corrections. Only the
audit reference qualified for ALG's retention score. The next test should
exercise recovery from an incomplete search before the owner issues a report.
[Local qualification and native comparison](evidence/calculation-actions-2.3.2.json)

### Resuming a partially observed cohort in preview.7

ALG records the last validated source window and the next permitted limit under
the owner's existing investigation journal. A compaction points to the exact
checkpoint it observed. After a restart, the owner can continue with the next
window using the same approved recipe. The plugin checks that the overlapping
rows and source reference still agree. If the approved windows run out, the
application reports abstention. A conflicting source also requires revalidation.
An early independent audit can be reused when its reference, row digest and
row count identify the selected owner cohort.

The owner's `status` result includes `evidenceReport` once the recipe has
observed relevant evidence. `incomplete` describes the outstanding read or
audit. `provisional` exposes measured facts while the recommendation is
unconfirmed. For a policy with `decisionRules`, `verified` returns the
calculated fields and source references once the approved rule and a subsequent
acknowledged decision agree on the action and prerequisite. Approval, settled
work, source evidence and decision revision are checked on read. An assistant
can still write its own provisional answer in the native chat.

The [installed evidence handoff benchmark](benchmark/evidence-handoff.md)
exercises a mid-search process restart and grades the native answer separately
from ALG's application report.

On Windows and WSL, both arms resumed at eight rows, qualified at twelve,
and made zero duplicate admissions in the scripted held-out case. Both changed
and exhausted sources produced abstentions. In one native Luna pair, ALG
reported the correct five defects and two corrections in chat. Its decision
write preceded the authoritative audit handoff, and it reached the 24-call cap
without a certified final answer. Build miscounted four defects and stopped.
ALG used 70,982 uncached input tokens and Build used 17,339. Both arms missed
the frozen end-to-end gate. [Receipts and ordered replay](evidence/evidence-handoff-2.3.2.json)

### Verify an independent child on its native completion

For an investigation with a pinned calculation procedure, opt in with the
following plugin option. Set the three names to the deployed subagent,
native lookup tool and source. Both the subagent's tool permission and its
`tool.use` permission must explicitly allow this read.

```json
{
  "childAudit": {
    "agent": "research-checker",
    "tool": "audit_lookup_pages",
    "source": "clock-audit",
    "scope": "whole-source"
  }
}
```

OpenCode's completion wakes the owner. ALG uses the event as a locator and
reads the finished child's tool input, complete result and final answer from
OpenCode. It checks the parent, workspace, role, permissions and selected
cohort before computing the approved measurements. The default scope,
`selected-cohort`, requires the tool result to identify the owner task,
source message, call, reference, row digest and count in `ownerCoverage`.
Choose `whole-source` only for an endpoint returning the entire named dataset
for a local join, as in the example. A child reading that endpoint without a
coverage record must have been created after cohort selection. The default lookup shape
is a single offset-zero page of at most 24 rows. A different field layout can
be configured through `childAudit.mapping`. Larger or paginated audits need
an appropriate evidence contract before they can certify a decision.

A later relay of the same rows preserves the proof. Conflicting rows produce
an abstention. Compaction saves the source locator with the measurement, and
the owner rechecks current authority before projecting or certifying it. The
owner must still write the supported action and prerequisite after observation.

The paired handoff receipt records cumulative UTF-8 request bytes by phase.
Native runs also record provider input and output tokens and matched host cache
reads. Cache reads are included in input tokens. Scripted runs can compare request
size and workflow correctness. Their token fields are null.

### Background compaction and independent research

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
