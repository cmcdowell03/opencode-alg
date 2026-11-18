# Native Build versus ALG: bounded V1 pilot

This is an end-to-end feasibility pilot, distinct from the earlier researcher-memo comparison. It compares native OpenCode Build, shipped ALG, and shipped ALG with an additional targeted checker mandate. ALG's shipped checker already uses adversarial instructions; the third arm is not a neutral-versus-adversarial comparison.

## 0.5.7 development instrumentation

The protocol/results below describe their historical cohorts. The current development runner defaults to paired Build/default-ALG trials; `track="targeted_compatibility"` selects the separate Build/targeted-ALG comparison. It retains issued-but-unstarted outcomes, separates artifact correctness from workflow/measurement eligibility, and records bounded final-census uncertainty. It does not make provider-request or invoice caps out of polled host counters. These changes do not rescore earlier cohorts.

Compaction is verified by new host markers and linked completed summary messages, rather than the summary endpoint's acknowledgement alone. Passive long-task telemetry reports successful/failed/unknown events, root/child counts, session lineage, frequencies with denominators and explicit missing coverage. Restart and reassignment remain part of the logical task. The retention evaluator distinguishes durable records, context projection, retrieval, applied behavior and externally observed repeated work. Its current fact evaluation is task aggregate; per-boundary obligation probes and actual long-task behavioral observations remain unqualified. An absent context fact or a zero-filled usage field is not a measured loss or complete usage receipt.

The offline retention analyzer accepts a bounded `alg-retention-input-v1` JSON document with `events`, `expectedFacts`, and optional `boundaries`. Task-level rates include observed time to first compaction, gaps between observed compactions and request-to-summary latency. Missing historical coverage suppresses rates; observed gaps can contain missing events. The optional boundary payload is separately validated against `RetentionBoundaryInputSchema`; it never upgrades an old task-aggregate observation into a boundary-level result. Frozen obligations, task/session identities, exact snapshots, current/revoked versions and externally observed behavior must be supplied by the evaluator. Without them, boundary retention is explicitly unavailable.

```sh
bun scripts/build-benchmark-retention-cli.ts observations.json new-retention-report.json
```

The same command works in PowerShell and Bash. It reads at most 16 MiB, writes only a new report, and records input/output hashes. It does not contact a model or authenticate caller-supplied observations. The actual model runner has not yet wired independent per-boundary probes or qualified full historical pagination. Therefore the analyzer and its synthetic positive/negative controls are measurement infrastructure, **not a measured long-session information-loss rate**. A later recovery must not erase an earlier boundary failure; a context omission alone must not become one.

Examples of how to interpret the layers:

| Observed sequence | Report |
| --- | --- |
| A result pointer leaves context; its durable record survives; the agent retrieves the current result and completes the scored action correctly | Context omission, successful recovery and no behavioral failure observed for that obligation |
| Original criteria survive on disk, but the resumed action uses altered criteria | Durable retention with behavioral failure; preserve the individual violation |
| A revoked procedure remains in old context, but a complete observed governed-action window shows it was not applied | Revocation respected for the exposed action; no claim the model forgot the text |
| The first boundary fails and the second succeeds | Two separate outcomes; the first failure remains in task-level accounting |
| A summary marker exists but completion or post-boundary observations are missing | Unknown completion or untested retention; no zero-loss rate |

These observations identify what failed. Estimating how much compaction *caused* the failure requires the predeclared matched with/without-compaction variants in the development plan.

The hard-case fixtures add service-owned work charges, durable idempotent query recovery, independent data-quality checks and executed repository compatibility tests. They still require a qualified MCP/headless interface, physical oracle isolation and shared-allowance enforcement before the new hard pilot. The runner deliberately reports isolation as unqualified. No new model comparison or superiority result is claimed for 0.5.7. See the [gated development plan](v1-reliability-and-build-comparison-plan.md) for those prerequisites and the long-task measurement design.

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

The runner waits for host sessions and tool calls to become idle before compaction, restart or scoring. Prompt dispatch uses the host's asynchronous endpoint; acknowledgement alone is not completion. The collector waits for a new root user message and its terminal assistant response, then for idle sessions/tools. Telemetry failure prevents an unqualified clean pass. Abort refreshes the session census before cancelling children. Temporary authentication copies are deleted, global configuration is checked for changes, and owned processes are stopped. Evidence contains synthetic task data; credential values are redacted, never published.

Not measured by this pilot: invoice-verified cost, hidden requests absent from session records, actual operator minutes, production MCP queries/cache reuse, general semantic-loop detection, sustained resource growth, multi-hour reliability, automatic skill promotion or real factory causal accuracy. No natural long-context-pressure claim follows from one explicit compaction. Native Bash/PowerShell transport and fixture checks are separate from real-model quality results.

## Running locally

Use `bun scripts/build-benchmark.ts /absolute/path/non-secret-config.json`. The config supplies `outputRoot` (must not exist), `hostExecutable`, `providerID`, `modelID`, and the OpenCode `provider` object with the declared output limit. Optional `authFile` identifies an existing provider credential file; values must not be embedded in this config. Optional `ollama` supplies `executable`, `models`, and `model`; the runner launches a loopback-only local service. `preflightOnly: true` verifies registration/configuration without inference. Optional `caseIds` selects a nonempty subset of the frozen cases, retaining their original arm order. Each new cohort requires its own output directory and manifest.

The harness never merges, edits user-global configuration or invokes GitHub runners. All model use is explicit through the selected local config. Results remain provisional until the terminal cleanup receipt exists; the raw failed receipts are retained.

## Results

The first cohort used synchronous prompt transport at commit `ce4623f`. Both longer ALG report trials encountered a request timeout before the declared eight-minute trial limit, at approximately 253 and 291 seconds. These receipts remain immutable and are classified as transport-censored, not clean model-quality failures. The exact client-versus-host HTTP timeout layer is not established. The initial coding outcomes stand; they are not repeated to improve their scores.

The runner now supports a separate prospective correction cohort using asynchronous dispatch, with prompts, fixtures, oracle, role instructions and budgets unchanged. No corrected Gemma cohort was launched: the user requested that local Gemma use end after the completed run because of resource pressure. The original Luna cohort is unavailable because its saved OpenAI authorization returned HTTP 401 before useful inference; it supplies no quality comparison. A future authorized cohort must preserve the original receipts and remain separate; it cannot replace them or be pooled as an extra repeat.

### Observed outcomes — 12 November 2026 UTC

The Gemma suite completed its six issued trials and cleanup. These are raw artifact scores, not a success-rate estimate. The report task had an additional setup defect: its skill file was present but not registered with the host. Build and its delegated child both received `Skill "wafer-analysis" not found`, then asked for the missing procedure instead of creating preparation. No trial reached compaction or restart. All three report trials are unqualified for the intended skill/recovery comparison; the ALG arms additionally encountered the premature transport cutoff.

| Task / configured agent | Independent artifact checks | Wall seconds | Assistant turns | Reported token components | Interpretation |
| --- | --- | --- | --- | --- | --- |
| Code / native Build | 8/8 | 134.73 | 6 | 51,089 | Correct repair |
| Code / default ALG | 5/8 | 55.38 | 4 | 44,345 | No repair; final response contained reasoning only |
| Code / targeted ALG | 8/8 | 104.11 | 7 | 82,993 | Correct direct repair; checker never invoked |
| Report / targeted ALG | 3/5 | 253.21 | 8 | 50,539 | Setup-invalid and transport-censored; no preparation/report |
| Report / default ALG | 3/5 | 291.38 | 11 | 62,550 | Setup-invalid and transport-censored; no preparation/report |
| Report / native Build | 3/5 | 74.35 | 5 | 36,921 | Required skill unavailable; preparation milestone absent |

Checks are not equally weighted outcomes. In the report task, the three passing checks only verify protected files were unchanged; they do not indicate partial analytical success. Wall times include final collection/scoring/cleanup after the active phase. Token totals sum reported components, including cache reads; they are not unique context size or invoice totals. Across all six Gemma trials: 41 assistant turns and 328,437 reported token components, including interrupted work. Provider cost is reported as zero and is not independently billed cost.

**Treatment fidelity matters:** neither ALG-configured coding trial invoked `alg_plan` or `alg_run`; none of the six trials reached an ALG checker. Thus the targeted coding success cannot be attributed to targeted review. Both ALG report trials did invoke one plan/run, completed explorer and researcher work, and started implementation. Targeted implementation first returned empty text; default research first failed a trimmed-string constraint and then recovered on retry. Those are observed child outcomes, separate from the later harness aborts. The durable graphs retained the completed sibling work and blocked state.

Build's report trial made two unsuccessful skill-load attempts; no successful skill-tool load was observed in any trial. This establishes a missing benchmark prerequisite, not evidence that an available skill was ignored. The future runner explicitly supplies the fixture skill directory and verifies registered name, path and content before any inference. The original preflight did not verify skill discovery and must not be described as full qualification.

**Decision:** this pilot does not show that ALG outperforms Build, that targeted checking is superior, or that real-model recovery works. It does expose useful measurement requirements: artifact correctness must be separate from host turn completion, graph/checker execution must be measured, and mandatory skills must be registered before starting. The asynchronous transport repair and explicit skill preflight are harness changes only; the 0.5.4 product runtime remains unchanged.

The user subsequently reconnected OpenAI and authorized Grok 4.7. The corrected hosted cohort below uses harness commit `fafff6c`, after synthetic host qualification. Keep free-choice agent comparison distinct from a future forced-graph diagnostic: one measures whether the orchestrator chooses ALG, the other whether a required graph completes. No new local Gemma run is scheduled.

The original six Luna trials all failed authorization refresh with HTTP 401; they remain availability failures, not model-quality failures. Both original suites recorded unchanged source/global configuration and successful process/auth cleanup. No GitHub runners, V2 changes or merge occurred. Raw outcomes and local verification receipts are retained in [the evidence directory](evidence/build-20261112/).

### Corrected hosted Luna cohort

OpenAI authentication succeeded after the user reconnected it. All six trials ran once with the original task prompts, oracle and budgets. Required skill registration was verified before inference. This cohort is separate from the authentication-unavailable records and the earlier Gemma results.

| Task / configured agent | Artifact checks | Workflow outcome | Wall seconds | Turns | Reported token components | Plan/run calls |
| --- | --- | --- | --- | --- | --- | --- |
| Code / Build | 8/8 | Passed | 41.61 | 8 | 58,491 | 0/0 |
| Code / default ALG | 8/8 | Token-budget stop | 141.10 | 22 | 204,728 | 1/1 |
| Code / targeted ALG | 8/8 | Token-budget stop | 164.30 | 25 | 208,122 | 1/1 |
| Report / targeted ALG | 8/8 | Token-budget stop after restart | 112.22 | 17 | 210,981 | 0/0 |
| Report / default ALG | 3/5 | Planned but did not create preparation | 31.25 | 6 | 69,145 | 1/0 |
| Report / Build | 8/8 | Passed after restart | 114.20 | 20 | 155,290 | 0/0 |

Native Build completed both requested workflows within budget. ALG-configured agents produced independently correct artifacts in three of four trials, but none completed the requested workflow within the fixed budget/phase requirements. This is descriptive evidence from two small tasks and one repeat; it is not a general ranking.

Both coding graphs completed exploration/research and wrote correct repairs, but their Windows gate helper failed compilation before `npm test` could launch. The first implementer attempt was recorded as `gate_failure`, exit 125, `termination_unverified`; the later retry consumed additional budget. The targeted retry also hit an extra-key schema error. The independent external tests passed the code in both arms. These outcomes expose setup/diagnostic/retry costs, not bad code or a failing test command. Neither graph reached its checker, so there is no end-to-end targeted-checker comparison here.

The default report arm loaded the skill successfully, created an ALG plan, and honestly stated that it had not executed it or created `preparation.md`. It therefore failed the requested milestone. The targeted report arm used no ALG graph: its artifact correctly preserved source priority, the unresolved conflicting observation, UTC arithmetic and the skill disclaimer after compaction and one host restart, but the turn hit the token threshold before normal completion. Build also passed the same recovery/artifact checks, loaded the skill twice, and completed within budget. Recovery is observed in these two specific runs; it is not evidence that ALG's durable graph state or approval/revocation machinery caused it.

The six trials recorded 98 assistant turns and 906,757 reported token components. All usage components were present in the persisted messages; host cost reported zero, which is not invoice evidence. The three token stops overshot the monitored threshold by 4,728, 8,122 and 10,981 components respectively while calls were in flight. Thresholds were not increased and failed trials were not replayed.

### Terra follow-up

At the user's request, `openai/gpt-6.1-terra` ran one separate six-trial cohort from commit `c096b6a`, using the same 0.5.4 runtime, harness, fixtures, oracle and budgets. No product or harness changes occurred during the run. Configured context/output caps remained 128,000/4,096; cumulative reported usage remained limited to 200,000 per trial across all agents and phases.

| Task / configured agent | Artifact checks | Root/phase outcome | Wall seconds | Turns | Reported components | Durable graph outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Code / Build | 8/8 | Passed | 53.90 | 6 | 42,123 | No ALG graph |
| Code / default ALG | 8/8 | Token-budget stop | 171.08 | 20 | 211,205 | Checker rejected missing evidence; feedback attempt interrupted |
| Code / targeted ALG | 8/8 | Passed | 140.49 | 19 | 199,134 | Four nodes passed on first attempts; graph done |
| Report / targeted ALG | 4/5 | Token-budget stop after restart | 174.01 | 22 | 201,534 | Preparation graph done; phase-two graph interrupted |
| Report / default ALG | 4/5 | Token-budget stop after restart | 157.31 | 20 | 202,811 | Preparation graph done; report absent |
| Report / Build | 8/8 | Passed after restart | 75.78 | 10 | 64,821 | No ALG graph |

Build completed 2/2 requested tasks. Default ALG completed 0/2 and targeted ALG 1/2 under the frozen limits. Both coding artifacts passed, and three internal ALG graphs completed: targeted coding and both preparation graphs. In the report rows, 4/5 means protected files and preparation passed while the final report was missing; it is not a partially correct report. The suite recorded 97 assistant turns and 921,628 reported components. Source/global configuration preservation and process/auth-copy cleanup passed for all six trials. Cost telemetry was zero, not invoice evidence.

Terra's coding plans omitted the optional shell gate; schema validation therefore allowed the implementer to proceed to the checker without invoking the failing Windows helper. Default's checker read source and rejected unsupported test-execution/preservation claims. The implementer had actually run tests, but the default graph passed its summary rather than host-origin command receipts. Targeted's checker passed after inspecting files and accepting claimed verification. Its model-authored criteria were also different: default explicitly required running tests and boundary checks; targeted used broader verification wording. This uncontrolled criterion/evidence difference prevents attributing the single win to the targeted mandate.

Both ALG report arms read the skill file directly, completed preparation, compacted and restarted. Neither produced the final report within budget. Direct skill reads are distinct from skill-tool loads; an empty skill-tool counter does not establish failure to consult the procedure. The interrupted phase-two graph was a new authorized phase, not demonstrated redundant planning. These outcomes identify workflow overhead and incomplete delivery, not evidence that compaction erased the saved preparation.

The frozen primary `passed` flag measures independent artifact success plus root/phase completion without a stop; it does not itself require an ALG graph to be done. Graph/checker outcomes are therefore reported separately. [Terra raw receipts](evidence/build-20261112/terra-corrected/result.json) and [the root-cause analysis with model-agnostic repair priorities](v1-benchmark-failure-analysis.md) accompany this follow-up. No local Gemma or additional paid replay was used.

### Windows helper finding and next fixes

A bounded local reproduction compiled the exact embedded helper source twice without executing either generated program. The PowerShell `Add-Type` route succeeded at source/output lengths 227/228 characters and failed at 291/292 characters with an output-filename-too-long/invalid diagnostic. [Short receipt](evidence/build-20261112/checks/helper-compile-short.json), [long receipt](evidence/build-20261112/checks/helper-compile-long.json).

The original failed helper paths were also approximately 291/292 characters, making path length a plausible cause. The original compiler's stdout was discarded, so its exact diagnostic/backend is not established by the old receipt. The reproduction proves the fallback route's long-path limitation; it does not retroactively recover the missing diagnostic. The benchmark's deep isolated temporary directories exposed this condition, and the resulting retries limit any clean orchestration-overhead comparison.

A subsequent selector-matched reproduction now confirms the same failure with production's selected .NET Framework `csc.exe`: 249/250-character source/output paths succeeded; 291/292 failed with `CS2021` on stdout and empty stderr. The exact helper bytes were unchanged, only two compiles ran, and neither executable was run. This reproduces the selected backend's defect and the reason its diagnostic was lost; the historical stdout itself remains unavailable. [New compiler receipt](evidence/build-20261112/checks/selected-csc-path-repro-d709bde3-4a59-47b5-a0b0-0ab806561d7f.json).

Before claiming deployment readiness or choosing a graph strategy:

1. Capture bounded compiler stdout/stderr and classify helper setup failure separately from test failure or uncertain termination. Preserve the fail-closed gate.
2. Make helper compilation tolerate long temporary paths, or fail preflight before spending model calls. A local long-path regression should cover the chosen production compilation route.
3. Route setup failures to environment recovery instead of asking the implementer to change already-correct code.
4. Treat the requested artifact/phase as the completion criterion; a plan alone must not satisfy a request to create preparation.
5. Measure the graph's context/usage cost before defaulting small tasks to a full diamond. Use a separate forced-graph diagnostic to reach and evaluate the checker; retain equal-budget Build comparisons as the user-facing efficiency test.

These are findings/recommendations, not runtime fixes claimed by this evidence commit. No model-specific routing or automatic promotion is justified.

### Grok availability and local qualification

The installed OpenCode catalog exposes `xai/grok-4.7`. Its six corrected-harness trials failed before inference because xAI rejected the saved OAuth refresh token (`invalid_grant`, HTTP 400). They contain zero model-quality observations and remain [availability receipts](evidence/build-20261112/grok-auth-unavailable/result.json). A fresh authenticated cohort requires the user's xAI reconnection; no silent substitution or retry is performed.

The async transport tests passed on Windows PowerShell and native Ubuntu Bash: six tests, 19 assertions on each platform; TypeScript passed on both. Real OpenCode 1.18.35 synthetic-provider smoke checks passed in all three arms on each platform, verifying registered skill identity/content, asynchronous completion handling and cleanup. The synthetic provider deliberately writes no preparation, so task scores fail by design; the separate transport assertions pass. A preceding Windows smoke had one successful transport arm and two host spawn failures (`uv_spawn`); that receipt is retained separately, not relabeled green.

Earlier fixture/metric checks recorded six Windows passes and one default-five-second test timeout, followed by a passing isolated recheck under the repository's standard 60-second timeout. Native Ubuntu recorded seven passes, 53 assertions. These overlapping checks are not a new full-suite run. [Local receipts](evidence/build-20261112/checks/) and the [byte-preserving evidence manifest](evidence/build-20261112/manifest.json) accompany the report.

All terminal suites preserve source/global configuration and report process/auth-copy cleanup. A separate census found no local model server processes after Gemma ended. No additional local Gemma trial, GitHub runner, V2 implementation or merge was performed. The benchmark-only commits do not change the product runtime identity or qualify a new offline package.
