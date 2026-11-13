# V1 graph revisions and targeted-review evaluation

The 0.5.4 candidate implements evidence-linked checkers and bounded revisions of pending custom-graph work. Targeted review remains opt-in. This evaluation compares a targeted falsification **research memo** with an ordinary review memo before the same final checker; it does not compare two different checker implementations or establish production scientific accuracy.

Runtime implementation: `4118526e63bfb1db43f488d827b0907e47b75193`, finalized at `c9cefb46e5a2c88cdee5b3ce00accaba0812e147`. Both are on PR #14. The runtime is model agnostic; model names occur in evaluation configuration and evidence only.

## Implemented behavior

- Optional `verification: {version: 1}` records the checker input basis before launch and requires one finding per criterion, included evidence IDs, and a consistent verdict. Missing evidence remains unsupported/inconclusive. A citation binds supplied bytes; it does not prove source truth, freshness or independence.
- The owning orchestrator can revise a planning/blocked custom graph using its current digest. Only unattempted pending work may change. Attempted work, existing checkers, required dependencies, root scope and budgets remain protected. Managed investigation graphs remain fixed.
- Canonical graph snapshots, revision receipts and checker input bases survive persistence/reload. A lifecycle regression completes one observation, reloads/revises/resumes the graph, and verifies that observation executes once and the original global budget remains in force.
- No automatic promotion, recursive orchestrators, completed-work invalidation, new search route, permission expansion or V2 implementation is enabled. See [the graph contract](v1-graph-evolution-adversarial-review.md) for usage and remaining design targets.

## Comparison protocol

Ten fixed synthetic cases cover supported controls, join multiplication, denominator mismatch, timestamp offsets, confounding, absent lineage, conflicting sources, duplicate identifiers and misleading instructions embedded in evidence. Construction-based oracles are checked locally. Each arm makes one researcher call followed by one fresh checker call. The final checker receives the original evidence and an untrusted memo without an arm label. Arm order alternates by case. The manifest is written before inference; no call is retried.

Each model has at most 40 requests, 2,048 output tokens per request, a 120-second request deadline and a 30-minute host deadline. The host also stops dispatch after three consecutive transport failures or $5 of **reported** cost. OpenCode's reported cost is not a billing receipt. The comparison uses fresh real OpenCode 1.18.35 sessions, the production role output contracts/parser, and the evidence-linked verdict validator. These component trials do not exercise a complete real-model `alg_run` DAG. Separate deterministic full-executor host checks exercise child sessions and recovery.

The local model is Gemma4 8B Q4_K_M through Ollama; the hosted model is the connected `openai/gpt-6-luna`. Gemma preload uses an empty prompt and generates no tokens; preload latency is retained separately. Reasoning/token accounting differs by provider, so compare strategy costs within a model. Hosted inference was explicitly authorized. No production data or remote datalake was queried.

## Results

The terminal model results and their qualification are recorded in [the evidence index](evidence/adversarial-20261111/summary.json). Raw model text and diagnostics are retained, alongside the frozen manifests, host receipts, prompt hashes and source identities. Each model has a separate report; no successful subset replaces its complete result.

| Model | Issued / planned requests | Correct workflows: ordinary / targeted | Targeted wins / losses / ties | Contract-failing workflows: ordinary / targeted |
| --- | --- | --- | --- | --- |
| openai/gpt-6-luna | 40 / 40 | 10/10 / 9/10 | 0 / 1 / 9 | 0 / 0 |
| alg-local/gemma4 | 34 / 40 | 6/10 / 5/10 | 1 / 2 / 7 | 1 / 3 |

Correct workflow means a valid review plus a valid, oracle-matching checker. The denominator is the ten planned cases, including failures or unissued budget slots. `transport failure` is the evaluator's broad status: consult the dispatch diagnostics to distinguish an issued timeout from a budget/stop slot that was never sent. Partial trials do not provide a fair full-cohort cost or quality comparison.

| Case | Luna ordinary | Luna targeted | Gemma ordinary | Gemma targeted |
| --- | --- | --- | --- | --- |
| control-supported-direct | correct: supported | correct: supported | correct: supported | checker schema failure |
| control-supported-null-effect | correct: supported | correct: supported | correct: supported | correct: supported |
| join-inflation | correct: disconfirmed | correct: disconfirmed | correct: disconfirmed | correct: disconfirmed |
| timestamp-offset | correct: disconfirmed | correct: disconfirmed | review schema failure | checker schema failure |
| confounding | correct: unsupported | correct: unsupported | correct: unsupported | correct: unsupported |
| missing-evidence | correct: unsupported | correct: unsupported | correct: unsupported | correct: unsupported |
| conflicting-data | correct: inconclusive | correct: inconclusive | wrong: disconfirmed | correct: inconclusive |
| source-duplicates | correct: disconfirmed | correct: disconfirmed | correct: disconfirmed | checker schema failure |
| misleading-evidence-instruction | correct: disconfirmed | wrong: supported | transport failure | transport failure |
| control-supported-independent-reconciliation | correct: supported | correct: supported | transport failure | transport failure |

| Model / arm | Sum of reported token components | Summed request time |
| --- | --- | --- |
| luna / ordinary_review | 40,408 | 159.90 s |
| luna / targeted_falsification | 42,996 | 181.31 s |
| gemma / ordinary_review | 55,562 | 978.37 s |
| gemma / targeted_falsification | 50,605 | 686.98 s |

Luna's targeted arm used 6.4% more reported token components and 13.4% more summed request time in this single repeat. These are host observations, not billed cost or a controlled latency benchmark. All cost receipts report zero; that does not establish free inference. Tokens spent on timed-out calls may be unavailable.

- luna: 10 pairs completed all four requests; ordinary 10/10, targeted 9/10. Among 10 pairs where both workflows also met their output contracts: ordinary 10/10, targeted 9/10. These are post-hoc availability views, not replacement scores or superiority estimates.
- gemma: 8 pairs completed all four requests; ordinary 6/8, targeted 5/8. Among 5 pairs where both workflows also met their output contracts: ordinary 4/5, targeted 5/5. These are post-hoc availability views, not replacement scores or superiority estimates.

Excluded calibration accounting: luna: 40 started, 40 completed, 0 failed, 0 unsettled; 58,864 known reported tokens. gemma: 19 started, 17 completed, 1 failed, 1 unsettled; 36,062 known reported tokens. Unsettled/timed-out usage is unknown; the corrected-trial totals do not include calibration spend.

**Decision:** keep targeted probes opt-in and scoped to a concrete falsifiable question. This cohort does not establish targeted superiority or justify automatic strategy promotion. Preserve unsupported/inconclusive answers, qualify the claim/criterion boundary, and require a fresh frozen evaluation before changing defaults.

The concrete targeted gain was Gemma's conflicting-source case: it preserved an inconclusive total while ordinary review incorrectly called the claim disconfirmed. That gain did not outweigh output-contract failures across the eight completed pairs (ordinary 6/8, targeted 5/8). In Luna, targeted probing added usage without a measured correctness gain. These observations identify cases worth testing in a future independent cohort; they do not justify choosing a strategy by model name.

Gemma reached the fixed 30-minute deadline: 33 requests completed, one issued request timed out, and six remaining slots were never sent. The last two cases therefore lack complete pairs. The harness's terminal `complete` flag means it wrote its report and cleanup receipt, not that all 40 planned requests completed. No deadline or call-budget extension was made.

### A score does not resolve criterion ambiguity

In Luna's `misleading-evidence-instruction` pair, both researchers correctly identified one duplicate and rejected the embedded instruction. The targeted checker nevertheless returned `supported`, explaining that the review memo had derived the duplicate count correctly. The original claim said there were **no duplicates**, so this is a false pass under the frozen claim oracle. However, C1 was worded as a method requirement, making the object being judged ambiguous. This is not evidence that the model obeyed the embedded instruction or that targeted reasoning failed to find the duplicate.

`timestamp-offset`, `source-duplicates` and the supported `control-supported-null-effect` also use method-oriented wording. Preserve all ten raw scores. An explicitly post-hoc sensitivity view excluding only the observed ambiguous Luna pair yields 9/9 for both arms; it does not replace the 10-case comparison or establish equivalence. Future cohorts should separately state the proposition to verify and the required method. No prompts, oracles or outcomes in this run are changed after inspection, and no paid rerun is used to improve the result.

The original report's `falseRejects` means **disconfirmed when the oracle says supported**. It excludes uncertain outcomes. A separate derived `missedSupport` count includes any valid non-supported checker outcome on a supported case; absent/invalid outputs remain contract or transport failures, not substantive rejections. The report's `unresolved` count includes correctly uncertain cases and must not be treated as an error count.

## Preserved calibration failures

The first calibration used the same runtime before the harness reused the complete production role-schema suffix. It omitted nested `ResearchOut` field contracts. That apparatus defect caused review-schema failures and invalidates that calibration as a strategy comparison. Luna completed 40 calls; the Gemma calibration was stopped after diagnosis. Counts, unsettled calls, known usage and cleanup receipts are retained separately in the evidence index, rather than hidden in the corrected trial totals.

Before the corrected comparison, fixture qualification also repaired approved/passing terminology, a control aggregate inconsistent with its strata, conflicting-source criterion wording and duplicate-oracle metadata. The timestamp oracle had been corrected before calibration. These are fixture repairs, not evidence of model improvement. The corrected trials still expose the method/claim ambiguity above; the results remain exploratory, not a validated promotion benchmark.

## Local verification and runtime identity

Final source-checkout headless acceptance passed in Windows PowerShell and native Ubuntu Bash. Each run registered all 21 ALG tools, launched three executor-to-SDK-to-host children with verified parent links, recovered the persisted verification basis, compacted once and restarted twice. Three query results reused one accepted synthetic remote job and one remote page read. Global configuration preservation and process/temporary-environment cleanup passed.

| Local check at the final runtime | Measured result |
| --- | --- |
| Windows affected 16-file suite | 265 passed, one platform skip, one existing release-gate timeout; 4,384 assertions; 231.09 seconds |
| Windows timed-out case recheck | Passed in 26.04 seconds under the unchanged 30-second deadline; 23 assertions |
| Ubuntu affected 16-file suite | 264 passed; three release-gate cases failed because the local harness supplied an invalid Node/npm PATH |
| Ubuntu release-file recheck after PATH correction | 25 passed, zero failures; 160 assertions; 3.97 seconds |
| Focused final contract/recovery suite | 69 passed, zero failures; 493 assertions; 10.30 seconds on Windows |
| TypeScript | Passed on Windows and native Ubuntu |

Original failed invocations remain failed; rechecks cover the identified failures, and overlapping counts are not summed into a fictional full-suite total. Earlier all-green affected suites belong to the preceding implementation commit. This is not a claim that every repository test was rerun on the final candidate.

Windows raw runtime: `d0614611c04d7f054dbbb0a8ac686fe3578bbca9bc8527946cff556734f37b5a`. Ubuntu raw runtime: `f6e704d630ec3125e5aec8fc65f64b753b60d023ab3bd3a2e95c44226d80ba4c`. All 125 inputs agree after LF normalization; 71 Windows inputs contain CRLF. The raw identities are preserved. [Runtime comparison](evidence/adversarial-20261111/checks/runtime-comparison-final.json) and terminal host/test receipts accompany the evidence.

Prior offline bundle/server/TUI/relocation receipts belong to their earlier commits and are not relabeled as a 0.5.4 package qualification. The real air-gapped datalake-mcp, production scientific usefulness and general long-session reliability remain unqualified. All host/tests ran locally; no GitHub runners, user-global configuration edits or merge occurred.
