# Live V1 retention diagnostic — partial exposure

This is the first live-model measurement for the new retention harness, not a completed long-session test or an ALG-versus-Build comparison. Windows OpenCode **1.19.5** used **openai/gpt-6-luna** with its catalog context capacity (1,050,000), a configured 4,096 output limit, and natural compaction enabled. ALG's runtime was unchanged from the previously qualified 0.5.7 implementation. No Gemma, V2 work, GitHub runner, merge, or user-global configuration edit was used.

| Observation | Measured result |
| --- | --- |
| Planned exposure | Seven phases, up to six requested compactions, two scheduled restart boundaries |
| Actual exposure | Preparation completed; phase 1 cancelled at the usage monitor |
| Compaction | One accepted request, new persisted marker and linked terminal summary; zero natural markers |
| Summary request/observation interval | 14.257 seconds |
| Completed continuation qualification | **Not achieved**; continuation was cancelled |
| Partial phase-1 artifact audit | 8/8 checks passed after cancellation |
| Unchanged obligations in that partial artifact | 6/6 present: criteria, skill version, calculated source summary, evidence references, cached IDs, artifact-size constraint |
| Completed-workflow information-loss estimate | **Unavailable**, not zero |
| Scheduled restarts | 0/2 reached; one additional host start resumed the session after an apparatus repair |
| Assistant turns | 43 across orchestrator, implementer, checker and compaction roles |
| Reported usage components | 608,348: input 140,739; output 9,086; reasoning 283; cache read 458,240 |
| Usage monitor | 600,000 component threshold; 8,348 polling/in-flight overshoot; no reset |
| End-to-end clock | 539.275 seconds, including apparatus-repair downtime; approximately 247.945 seconds in observed prompt/summary intervals |
| Session census | 4 sessions / 49 messages; collected IDs match the stopped host's read-only database census |
| Cleanup | Captured hosts stopped; temporary auth copies removed; runtime and user-global configuration unchanged |

The component total is a sum of session-reported fields, not distinct context occupancy, billable tokens, or an invoice estimate. The API reports cost as zero; that is not a claim of free usage. The observed natural-compaction rate was zero over this short exposure. The requested-compaction cadence (6.676 per elapsed task hour) was imposed by the experiment and is not a production rate. The elapsed denominator includes the repair pause. Neither rate should be extrapolated to long sessions.

The partial artifact audit is deliberately separate from the runner's completed-boundary aggregate. The latter has zero qualified completed continuations and a null loss rate. `continuation/partial-phase-1-audit.json` scores the already-written phase-1 output offline, using a temporary copy to execute its utility and tests. It records 6 comparable obligations retained and no observed artifact mismatch. This does not establish hidden-context recall or compaction causality. Durable mission files remained available; the synthetic answers were disclosed task requirements, not a blinded scientific challenge. Two native skill loads and one skill-file read occurred before compaction; no post-compaction native skill load was observed. A correct version field alone is not proof of renewed procedural skill use. The procedure-v2 transition was not reached.

## All attempts and apparatus corrections

1. `4a17e18`: frozen initial diagnostic. ALG completed its implement/check graph in about 159 seconds, using 26 assistant turns. The scorer incorrectly required cached IDs in prose as well as in the required JSON. The JSON contained both correct IDs. This was an **undisclosed oracle requirement**, not an ALG failure. The original failed receipt is retained in `initial/`; it has not been rewritten into a pass.
2. `94472fe`: removed that extra prose criterion and added a regression. A specifically bounded continuation reused the prepared session instead of paying to repeat preparation. Original wall, turn and usage limits carried forward. Its first setup failed before any model call because dependency seeding requires a fresh directory; see `continuation-setup-failure/`.
3. `dc83b64`: reused the existing isolated dependencies. The continuation froze a new apparatus plan, preserved the original project/database snapshot externally, rescored preparation without model calls, and performed one actual compaction. The usage threshold then stopped phase 1 before its full graph completed. No further paid trial was issued.
4. The final harness also preserves a separate partial-artifact audit automatically after cancellation. This logging improvement was made **after** the live run and was not exercised by that paid run; the retained manual offline audit uses the same scorer/delta logic.

No runtime or model-specific repair was needed. These results exposed measurement defects and an overly short exposure budget, rather than evidence that ALG lost information. The initial seven-phase run is still **incomplete** and remains development evidence.

## Local qualification and next measurement

The initial fixture/runner guards passed 17/17 tests on Windows and native Linux Bash. The scorer/no-reset repair passed 19/19 on both; final Windows typechecking and 19/19 focused tests passed. Release-input/package exclusion checks passed 25 tests with one POSIX-only skip on Windows. The frozen runner passed a native Linux OpenCode **1.18.35** headless preflight without model generation. The first Linux attempt encountered Git's Windows-mount ownership guard; the second used a process-scoped trust entry for this exact checkout, with no global Git change. A no-model Windows preflight also caught a missing required context-limit field before the trial. Earlier failure receipts/logs remain preserved.

The next long-session experiment needs an exposure budget derived from measured per-phase use, with input/output/cache components reported separately, sufficient completed boundaries, meaningful work rather than padding, and natural versus requested compaction strata. A larger budget must be frozen before another paid run; this run's limits were not enlarged. Reassignment, procedure revision, planned restart recovery, expensive-search repetition, multiple models, and a fair Build baseline remain unmeasured here. Completing those gates remains necessary before claiming long-session reliability or superiority.

The manifest hashes the selected credential-free receipts byte for byte. Full message history, snapshots and the standalone offline audit script remain under the local `implementation-evidence/live-retention-*` paths referenced by the plans; auth files and databases are not published.
