# Native Build versus ALG: bounded V1 pilot

This is an end-to-end feasibility pilot, distinct from the earlier researcher-memo comparison. It compares native OpenCode Build, shipped ALG, and shipped ALG with an additional targeted checker mandate. ALG's shipped checker already uses adversarial instructions; the third arm is not a neutral-versus-adversarial comparison.

## Frozen protocol

Two tasks run once in each arm for each model: a dependency-free CommonJS wafer API/UI repair and a staged skill-guided wafer report. The second task must persist preparation before the harness compacts the actual OpenCode session, stops/restarts the host, and submits the same short continuation prompt to every arm. A task that never reaches preparation is not credited with a recovery pass.

Each arm starts with identical fixture files, a fresh Git repository, isolated home/config/cache/database, the same external tool permissions, and the same model for parent, child and maintenance agents. Build retains its native delegation and native role instructions, without ALG installed. ALG uses its shipped role definitions and tools. Internal role permissions and step limits are part of the product being compared. The targeted arm adds only the recorded checker mandate; preflight verifies the loaded checker prompt. Existing default ALG templates remain available, and the model chooses how to use them.

The first case order is Build/default ALG/targeted ALG; the second reverses that order. One repeat is a smoke-level feasibility comparison, not a reliable ranking. Models are separate strata. Any cross-model concurrent execution and shared-machine load limit latency interpretation.

Each trial has an eight-minute active wall deadline, a monitored 40 session-visible assistant-turn threshold and 200,000 reported-token threshold across parent and child sessions, and a 4,096-token per-response model limit. Pending calls can cross a monitored threshold before cancellation; the observed turn overshoot is recorded. The six-trial model suite has a 55-minute deadline including startup and a $5 reported-cost stop. Unknown or zero-reported provider cost is not proof of zero billing, and this is not an independently enforced dollar cap. No automatic trial replay is performed.

## Independent scoring

The external scorer is not copied into the task workspace. The code task is assessed against held-out duplicate, timestamp-offset, half-open boundary and UI checks. Supplied data, visible tests and package metadata are protected by byte comparisons. The report task has a common user-requested JSON deliverable contract, independent checks of arithmetic, source provenance, conflicting observations and the skill's explicit scope notice. This contract is identical for Build and ALG; Build is not judged on ALG's internal output schema.

Preparation is scored and captured before compaction, rather than inferred from files written later. Report success and workflow completion remain separate: a correct artifact produced by a run that exceeds the budget is recorded as a correct artifact but not a within-budget workflow success. ALG's checker verdict and DAG status are diagnostics, not the oracle. Stated completion claims require separate inspection of the final response.

Before inference, fixture tests must demonstrate the original bug fails, a known repair passes, protected-file changes fail and report/preparation scoring handles declared equivalent representations. The manifest freezes prompts, case files, source identity, harness/fixture/metric hashes and limits. No criterion or oracle is adjusted in response to a model outcome.

## Measurements and limits

The neutral collector polls session/message endpoints, deduplicates by session/message ID and retains parent/child identities. It records finished/unfinished/error turns, raw token components, reported cost and unknown coverage, tool status and duration, exact repeated tool inputs, skill-tool loads, ALG plan/run calls, phase times and final files. Repeated input is not automatically waste; loading a skill is not proof of application. Correct use of the applicable procedure is scored from the resulting report separately.

The runner waits for host sessions and tool calls to become idle before compaction, restart or scoring. Telemetry failure prevents an unqualified clean pass. Abort refreshes the session census before cancelling children. Temporary authentication copies are deleted, global configuration is checked for changes, and owned processes are stopped. Evidence contains synthetic task data; credential values are redacted, never published.

Not measured by this pilot: invoice-verified cost, hidden requests absent from session records, actual operator minutes, production MCP queries/cache reuse, general semantic-loop detection, sustained resource growth, multi-hour reliability, automatic skill promotion or real factory causal accuracy. No natural long-context-pressure claim follows from one explicit compaction. Native Bash/PowerShell transport and fixture checks are separate from real-model quality results.

## Running locally

Use `bun scripts/build-benchmark.ts /absolute/path/non-secret-config.json`. The config supplies `outputRoot` (must not exist), `hostExecutable`, `providerID`, `modelID`, and the OpenCode `provider` object with the declared output limit. Optional `authFile` identifies an existing provider credential file; values must not be embedded in this config. Optional `ollama` supplies `executable`, `models`, and `model`; the runner launches a loopback-only local service. `preflightOnly: true` verifies registration/configuration without inference.

The harness never merges, edits user-global configuration or invokes GitHub runners. All model use is explicit through the selected local config. Results remain provisional until the terminal cleanup receipt exists; the raw failed receipts are retained.

## Results

Results will be recorded after the frozen bounded trials finish. This protocol does not claim that any arm has passed or outperformed another.
