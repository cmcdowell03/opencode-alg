# Why the V1 benchmark runs fail

This analysis separates artifact correctness, root-turn completion, graph completion, and benchmark limits. It uses the preserved Luna attempts and a separately bounded Terra cohort at the same product runtime. The original Gemma skill-discovery and synchronous-transport problems belong to the test apparatus and are already described in [the benchmark report](v1-build-benchmark.md).

**Repair status, 0.5.5 candidate:** the recovery, evidence and planning repairs are implemented in commits `f5f0929` and `373b8d0`. [Local validation and a separate prospective Windows/Linux Terra cohort](#post-repair-validation--windows-and-linux) are recorded below. The earlier diagnosis remains tied to its original runtime. Mechanical recovery checks pass; cumulative usage and inappropriate graph selection still prevent some whole tasks completing. No general completion/cost improvement or 0.5.5 offline-package acceptance is claimed.

## The confirmed failure chain

```mermaid
flowchart LR
  A[Implementation produces correct code] --> B[Windows Job helper compilation fails]
  B --> C[Gate command never launches]
  C --> D[Executor records gate_failure]
  D --> E[Implementer is called again]
  E --> F[More cumulative usage]
  F --> G[Benchmark cap or graph attempt limit]
  G --> H[Checker never runs]
```

The Windows shell path constructs and compiles a private Job Object helper before launching the requested command. A setup exception returns exit 125 with `termination_failed: true`, even when no test process has launched. The executor turns that into `termination_unverified`, classifies the attempt as `gate_failure`, and makes the node pending again while attempts remain. Its next attempt starts a fresh implementer session. The successful model output is retained, but there is no separate gate-only recovery in this path.

This is the wrong recovery target for a compiler/setup problem: another model turn cannot repair the host's helper build merely by rewriting a correct project artifact. The gate's refusal to approve an unverified execution remains appropriate. The problems are setup compatibility, missing diagnostics, failure classification, and retry routing—not evidence that the tests ran and rejected the code.

Relevant implementation: [helper compilation and setup](../src/shell.ts), [gate classification and retry](../src/executor.ts). The compiler's stdout is discarded while only stderr is retained. This loses diagnostics from compilers that report errors on stdout. The setup catch also conflates failure to establish containment with failure to terminate an already-running command.

The follow-up reproduction used the production selector's first existing candidate, `Framework64/v4.0.30319/csc.exe` (version 14.8.10001.0), with the exact 5,786-byte embedded source and an isolated environment without `ProgramFiles`. Source/output paths of 249/250 characters compiled successfully. At 291/292 characters, the same compiler exited 1 with `fatal error CS2021: File name ... is too long or invalid` on **stdout**, with empty stderr. Exactly two compiles ran and neither resulting program was executed. This reproduces both the long-path defect and the lost diagnostic using the selected backend, strengthening the earlier fallback-only reproduction. The original discarded stdout remains unrecoverable.

The selector checks fixed .NET locations, not PATH; `Get-Command csc` alone cannot qualify its availability. The earlier PowerShell fallback receipts remain unchanged. [Selector-matched reproduction](evidence/build-20261112/checks/selected-csc-path-repro-d709bde3-4a59-47b5-a0b0-0ab806561d7f.json).

## A different Terra failure: insufficient verification evidence

Terra's default coding plan omitted the optional shell-gate command. The shipped `coding-diamond` implementer uses a schema gate by default, so its first implementation passed without encountering the Windows helper. This is not evidence that Terra repaired or bypassed a configured gate. It chose a different plan through the same available interface.

The checker then inspected the source and accepted that the implementation expressed the requested count, interval and label behavior. It rejected the test-execution and preservation claims because the supplied output did not include the executed test output, independent assertions, or sufficient status evidence. Its `score: 6` / `passed: false` was a valid substantive rejection, followed by a feedback-routed implementation attempt. The benchmark's usage limit interrupted that attempt.

The default graph wires `claimed: implement` to the checker, without the optional selected-evidence inputs. The checker may read files but is explicitly forbidden to execute shell commands. Thus a successful schema check and a worker's statement that tests passed do not give it reliable evidence that those tests actually ran. A code-correctness pass in the external benchmark does not make this internal evidence gap disappear.

This identifies a separate design need: supply bounded, host-recorded verification receipts to the existing artifact/evidence path, including the command, working directory, exit outcome and relevant output, with run/node/attempt identity. For preservation criteria, capture the relevant pre-work basis instead of expecting the checker to reconstruct it from final files. Do not resolve the gap by treating a model-written success claim as a trusted execution receipt or weakening the checker.

The default implementer actually executed `npm test` and independent boundary/offset assertions. Those tool results were present in its session but not supplied to the checker. The missing link is between executed verification and the checker input. The checker correctly distinguished readable source behavior from unsupported execution/preservation claims.

Terra's targeted coding graph subsequently completed all four nodes on their first attempts, with a passing external artifact oracle. Its plan also omitted the shell gate, and its model-written criteria were not identical to the default plan: the default added an explicit hard requirement to run tests and verify boundaries, while targeted used broader verification wording. The targeted checker accepted the claimed verification after inspecting files. The frozen user request did not explicitly require a test execution log. Adding testing is a reasonable engineering step, but promoting it into a hard criterion without a matching evidence channel changes what the checker must prove. This is a criterion-provenance and evidence-delivery problem; the single differing verdict does not isolate the targeted mandate's effect.

## A second failure: stopping after planning

In Luna's default report trial, the requested phase was to write `preparation.md` and stop before writing the report. The agent loaded the skill, made a graph plan, then ended its turn explicitly saying preparation had not been created. That is an unmet deliverable, not a schema parse failure, compaction failure, or false claim that the file exists.

The plan response already said `status: planning` and `next: Call alg_run`. The shipped orchestrator's typical flow says plan then run, but its communication rule also allows reporting a run ID and only prohibits claiming unfinished work is done. There is no explicit instruction that an artifact request must proceed from a successful plan to execution before a final answer. The agent therefore ended honestly but prematurely; no host error, budget stop, or missing skill caused this trial's failure.

The smallest correction is to state in both role guidance and the plan response: if the user requested work, call `alg_run` after a successful live plan; stop at planning only for an explicitly plan-only or dry-run request. This remains model-followed guidance. A deterministic combined plan-and-execute action would require a separate action contract, retaining `alg_plan` for legitimate plan-only use. Neither approach should create an unbounded continuation loop.

## What the token stops actually mean

The benchmark enforces 200,000 cumulative reported token components across all assistant turns and child sessions. It counts cache-read components and is separate from the configured 128,000-token per-context limit. It is not an invoice-verified cost cap. Three Luna trials stopped at that usage threshold; the plugin itself did not report a 200,000-token context overflow.

The coding graphs also had a confirmed helper setup failure before their budget stop, so their cost is not a clean measurement of a functioning diamond. The targeted report trial produced a correct artifact after compaction/restart without using an ALG graph; it nevertheless crossed the same cumulative threshold before normal root completion. Increasing the limit might allow more work to finish, but it would not repair deterministic helper setup or establish efficiency.

Recomputed Luna coding usage, using the existing message-deduplicating collector:

| Session/attempt | Default ALG | Targeted ALG |
| --- | ---: | ---: |
| Primary agent | 17,929 | 57,315 |
| Explorer | 16,757 | 23,848 |
| Researcher | 26,108 | 30,219 |
| First implementer | 98,255 | 56,782 |
| Second implementer | 45,679 | 39,958 |
| Total reported components | 204,728 | 208,122 |

The second implementation attempts accounted for about 22.3% and 19.2% of those totals. Removing a futile retry addresses measured spend, but does not prove the remaining budget would suffice for a checker. Native Build used 58,491 reported components on this coding task. About 57–58% of the ALG totals were cache reads, so these ratios cannot be treated as dollar-cost ratios.

For the staged report, targeted Luna used 107,820 components initially, 8,656 during compaction and 94,505 during follow-up. Build used 68,459, 4,961 and 81,870 respectively. Targeted loaded the skill successfully; both approaches reread source files after compaction. Those reads are consistent with restoring current evidence. Repeated reads across fresh agents are not automatically wasted searches, and the saved telemetry cannot assign token cost to each read or isolate the exact prompt/tool-schema overhead.

The [attribution JSON](evidence/build-20261112/checks/luna-usage-attribution.json) is reproducible with `bun docs/evidence/build-20261112/checks/analyze-luna-usage.ts` from the repository root. Tool-call `completed` means the tool returned, not that the returned graph status was successful; graph status must come from durable run state.

## Reading the scores correctly

The frozen runner's `passed` flag means the independent artifact oracle passed and the requested root phases finished without a recorded budget/transport/model stop. It does **not** require an ALG run to have reached `done`. This deliberately avoids grading native Build against ALG-only contracts. For diagnosis, report these separately:

- Correct artifact and protected inputs.
- Within-budget root/phase completion.
- Whether a graph was planned and executed.
- Graph terminal status, child attempts, and whether a checker actually completed.
- Successful skill load and correct application after compaction/restart.

No targeted-review benefit can be inferred from a trial that never executes its checker. A stronger model also cannot be credited with fixing the Windows helper merely because its final code passes the independent oracle.

## Terra result and implications

The six-trial `openai/gpt-6.1-terra` cohort used the same runtime, fixtures, oracle and budgets. Native Build completed both tasks. Targeted ALG completed the full coding graph and passed the external code oracle, using 199,134 reported components versus Build's 42,123. Default ALG produced correct code but its evidence-repair attempt crossed the cap at 211,205.

Both ALG report arms completed a four-node preparation graph, including the checker, and recovered after compaction plus one restart. Each then hit the cumulative cap before `report.json` existed: default 202,811 components; targeted 201,534. Targeted had begun a separate phase-two graph when interrupted. This is authorized phase progression, not proof of redundant planning. Each ALG arm read the applicable `SKILL.md` directly once; neither used the skill tool. An empty skill-tool counter therefore does not mean the skill was never consulted.

Three Terra graphs reached `done`: coding/targeted and both preparation graphs. Two further graphs were blocked when the benchmark stopped. These internal completions are distinct from whole-task success: only one of the four ALG-configured trials completed the user deliverable within the frozen limits. Native Build was 2/2. See the [full measured table](v1-build-benchmark.md#terra-follow-up).

Across the six Luna/Terra coding trials, the independent code oracle passed every artifact. Failures centered on completing verification reliably: Windows setup and retry routing in Luna, evidence delivery and criterion differences in Terra, and cumulative usage limits. The report trials show additional orchestration/efficiency problems; they do not establish a general compaction or skill-loss defect.

## Model-agnostic repair order

1. **Make gate setup reliable and observable.** Capture bounded stdout/stderr and the chosen compiler identity; use a long-path-compatible private helper build route. Qualify it before costly graph execution. Retain containment and fail-closed behavior.
2. **Separate environment recovery from code repair.** Give setup failure a distinct outcome and block futile implementer reruns. Any gate-only resume must validate that the saved output, relevant files and gate identity still match; do not silently approve old work.
3. **Deliver evidence the checker can verify.** Reuse the existing artifact and selected-evidence channels for bounded host-origin test receipts and the relevant pre-work basis. Identify original requirements separately from model-derived verification methods. Freeze criteria for controlled checker comparisons.
4. **Close the plan-to-run handoff.** Clarify execution intent and preserve an explicit plan-only path. An honest plan is not the requested implementation or preparation artifact.
5. **Choose graph size for the task.** Measure usage and select the smallest workflow that supplies the needed independent checks. Avoid repeating a full exploration/research sequence for a small continuation when validated evidence can be reused. Do not special-case model names or treat a larger spending limit as a repair.

The original analysis recorded diagnosis, reproducers and the bounded Terra experiment before these product repairs were implemented. Its historical tests/probes ran locally; no local Gemma inference, GitHub runners, V2 work, global configuration edits or merge occurred. The evidence and runtime identities remain unchanged.

## Implemented 0.5.5 repairs

| Diagnosed gap | Pending candidate implementation | Remaining boundary |
| --- | --- | --- |
| Windows helper setup and lost diagnostics | Shorter private helper paths, bounded compiler identity/stdout/stderr, runtime preparation before model-attempt reservation, explicit `setup_failed` diagnostics | No claim that the old failed commands ran; new setup failures remain possible and fail closed |
| Futile implementer retry after setup failure | Stop automatic retry; explicit resume may rerun only the gate with matching saved output, gate/cwd and bounded declared-file basis | Uses normal local/global attempt slots, preserves limits, refuses stale/missing bases; does not bind every workspace file |
| Checker missing executed verification | Persist bounded native child `bash` and shell-gate receipts and deliver available related evidence to the checker | Missing exit metadata stays unavailable; tool completion and gate success do not prove test adequacy or semantic truth |
| Preservation claim missing a pre-work basis | Optional explicit `preserve_paths`, max eight files, 512 characters per path, 1 MiB per file; host before/after hashes persist on attempts | Original before basis stays fixed across retries; unlisted files are not scanned and snapshots do not verify tests |
| Premature final answer after planning | Live work/artifact guidance proceeds to bounded `alg_run`, preserving plan-only/dry-run and reused-done behavior | Model-followed guidance; no automatic continuation loop or new permission |
| Full diamond overhead on known small work | Opt-in `coding-compact`: implement → fresh checker, two attempts per node, four total, concurrency one | Original criteria and required verification remain authoritative; improved efficiency is not yet measured |

Researcher suggestions do not silently become new hard acceptance criteria. The repair adds no V2 runtime and does not resolve real air-gapped service qualification. The historical failure counts, token sums, artifact results and compiler reproductions above are preserved.

## Post-repair validation — Windows and Linux

Tested product: **0.5.5**, commit `373b8d04c22d82c9a04c65d99d87cb164d4dc955`. Documentation/evidence commits after this point do not change the runtime. Implementation includes the original host receipt through repeated gate-only recovery, a persisted recovery intent before gate launch, and clearing obsolete failure sidecar references when an interrupted attempt receives a replacement failure.

All tests ran locally. Windows used PowerShell; Linux used native Ubuntu/glibc in the dedicated `ALG-V1-Ubuntu` WSL distro, Bash, and a native filesystem checkout. Both hosted-model cohorts used OpenCode **1.19.5**, Bun 1.3.14 and `openai/gpt-6.1-terra`. The Linux executable has an `.exe` filename but is the Linux binary. No local Gemma, GitHub runners, global configuration changes, V2 work or merge was used.

### Regression and headless evidence

| Check | Measured result |
| --- | --- |
| Native Linux final affected suite | 280 passed, ten Windows-only skips, zero failures; 3,575 assertions across 17 files, 61.97 s |
| Windows final focused recovery/evidence suite | 22 passed, zero failures; 147 assertions across three files, 16.84 s |
| Windows package/manager suite | 123 passed, one POSIX-only skip, zero failures; 925 assertions across five files, 1,419.67 s |
| TypeScript | Passed on both platforms at the final implementation |
| Windows and Linux OpenCode 1.19.5 headless checks | Both passed: 21 registered tools, three verified child-parent links, recovered checker basis, one real compaction and two restarts |
| Headless remote-work reuse | One accepted synthetic job and one remote result-page read on each platform; recovered result revalidated after restart |
| Additional Linux compatibility check | OpenCode 1.18.35 headless fixture also passed |
| Runtime identity | All 129 inputs match after CRLF-to-LF normalization; 71 have different raw bytes. Raw digests remain distinct |
| Isolation | Headless host/provider/MCP cleanup, temporary environment removal and unchanged user configuration all passed |

The Windows package/manager invocation began before the final lockfile/lineage correction and completed after it; it is not a single full-suite run at the final commit. The earlier Windows core invocation remains **240 passed / one failed** (interrupted failure-sidecar replacement); scoped recovery checks passed after the fix. The earlier Linux invocation remains **278 passed / ten skipped / two failed** (lockfile version and repeated-recovery receipt lineage); the final 280-pass invocation includes both repairs. These overlapping sets must not be added into a unique test count. No full-repository all-green invocation or newly installed offline bundle is claimed.

The Windows helper regressions cover a long TEMP root for which the old helper path exceeded the legacy compiler limit, successful execution with the compact helper path, and deeper-path failure retaining compiler stdout/identity. Unlimited Windows path support is not claimed. Other regressions exercise setup admission before model calls, cancellation, unchanged-file gate-only recovery, repeated/interrupted recovery, stale bases, original preservation hashes and ordinary retries after real test failure. Linux exercises the equivalent executor/evidence behavior with its native shell backend; it does not compile the Windows helper.

Raw runtime digests:

- Windows: `dec1c48b6190ab7031766373f45a2992f33e3291af9f5a5a289a39c26794ea83`.
- Linux: `6e23a2b2fa0aa1078eb39d8cb24df613769535ccb31d718800530e28907d1e9d`.

See [local check receipts](evidence/reliability-20261112/checks/), [runtime comparison](evidence/reliability-20261112/checks/final-runtime-comparison.json), and [byte manifest](evidence/reliability-20261112/manifest.json). Existing package/TUI/relocation receipts retain their older source identities.

### Prospective Terra results

One six-trial cohort per platform; no paid trial was replayed to improve its score. The same frozen harness and fixture hashes, initial prompts, three arms and external limits were used: eight minutes and 40 assistant turns per trial, 200,000 cumulative reported token components, 4,096 output tokens, and 55 minutes per suite. Usage includes cache reads, is polled between observations and can overshoot the threshold; it is not context occupancy or verified billing. Model-written graph choices and criteria were free to differ, and local test load was not controlled. This is not a causal OS, latency or adversarial-strategy ranking.

| Platform / task | Arm | Whole task | Artifact oracle | Reported components | Wall seconds |
| --- | --- | --- | --- | ---: | ---: |
| Windows / coding | Build | Completed | Pass | 35,312 | 42.57 |
| Windows / coding | Default ALG | Usage stop | Pass | 211,519 | 126.33 |
| Windows / coding | Targeted ALG | Completed | Pass | 190,950 | 120.49 |
| Windows / report | Build | Completed, contract failed | Fail | 72,782 | 71.42 |
| Windows / report | Default ALG | Usage stop | Fail: no final report | 202,286 | 134.47 |
| Windows / report | Targeted ALG | Usage stop | Fail: no final report | 211,427 | 111.74 |
| Linux / coding | Build | Completed | Pass | 31,606 | 29.40 |
| Linux / coding | Default ALG | Completed | Pass | 171,725 | 115.23 |
| Linux / coding | Targeted ALG | Completed | Pass | 189,909 | 108.10 |
| Linux / report | Build | Completed | Pass | 70,064 | 73.29 |
| Linux / report | Default ALG | Usage stop | Fail: no final report | 212,640 | 134.98 |
| Linux / report | Targeted ALG | Usage stop | Fail: no final report | 211,828 | 134.29 |

Whole-task passes are Build/default/targeted **1/2, 0/2, 1/2 on Windows** and **2/2, 1/2, 1/2 on Linux**. All six coding artifacts passed. Windows Build's report computed the correct values, retained the conflict and exact scope warning, but supplied `limitations` as a string instead of the required array. The frozen oracle calls this `skill-procedure-and-scope`; it is an output-shape failure, not evidence that the scope warning or skill knowledge was absent. Its grade remains unchanged.

What the new evidence establishes:

- **Native verification receipts are present.** The default Windows coding implementer and both Linux coding implementers persisted four native command records with host-reported exit zero. Both Linux coding graphs and the targeted Windows coding graph finished all four nodes on their first attempts. The default Windows checker was interrupted by the external usage stop; that abort is not a new parser or helper failure.
- **Graph choice remains unreliable.** Windows default report and Linux targeted report chose research graphs for a task requiring a root-level `preparation.md`. The researcher is restricted to run-artifact writes and cannot create that deliverable. Their checkers correctly rejected the missing file; retrying the same role cannot resolve the capability mismatch. This reproduced across operating systems and checker mandates.
- **Preparation completion is not whole-task completion.** Windows targeted report finished its preparation graph but exhausted the shared budget before the restart phase. Linux default report finished preparation, recovered after actual compaction and one restart, then began a two-node implement/check continuation and hit the cumulative cap. No final report existed in any ALG report arm.
- **None of these ALG trials stopped immediately after planning.** Planning proceeded into execution. This bounded observation does not prove the model will always follow the guidance.
- **The optional gate and preservation requests were not exercised by the completed coding plans.** Their native commands provide execution evidence; the live cohort alone does not qualify Windows helper recovery or before/after preservation. Those mechanisms are supported by the targeted regressions, not inferred from tool completion.

Both cohorts completed without a harness-fatal error, reported unchanged source/global configuration, and recorded successful host cleanup and removal of every temporary auth copy. All twelve known auth-copy locations were independently checked absent. Full local host transcripts are retained with hashes; published evidence includes plans, results, bounded durable attempt details, artifacts and test logs. See [Windows result](evidence/reliability-20261112/windows/result.json), [Linux result](evidence/reliability-20261112/linux/result.json) and [combined summary](evidence/reliability-20261112/summary.json).

### Remaining work before claiming general reliability

Keep the PR draft. The implemented fixes address deterministic setup/recovery and evidence-delivery defects, but do not establish reliable completion of arbitrary user tasks. The next bounded design change should make graph capabilities and requested deliverables explicit at admission: a worker set unable to write the requested artifact must trigger correction before any expensive child calls. That should use typed capability contracts, not model-name branches or guesses from isolated keywords.

Task sizing also needs prospective evaluation: prefer the compact graph for already-understood edits, preserve the user's complete output contract, and account for all phases under one usage budget. The Linux continuation selected a two-node graph only after spending most of the budget on preparation; offering a compact template alone does not solve allocation. Any future comparison should freeze the original acceptance criteria and distinguish execution, artifact shape and scientific correctness. No new paid evaluation, automatic promotion, or production datalake qualification is implied by these results.
