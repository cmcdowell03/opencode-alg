# V1 Phase One implementation status

PR [#14](https://github.com/cmcdowell03/opencode-alg/pull/14) contains a partial, experimental Phase 1a/1b implementation against main baseline 99b88cd. The current candidate is 0.5.1 and targets OpenCode >=1.18.0 and <2.0.0. It is not merged or released.

**Review correction, 10 November 2026:** the earlier 80% completion estimate is withdrawn. It over-weighted implemented plumbing and synthetic acceptance while service qualification and the full investigation workflow remain unresolved. The existing HTTP transport is an ALG reference protocol, not an adapter verified against the real datalake-mcp API. Local passing tests do not close those merge blockers.

## Delivered contracts

| Contract | Implementation | Qualification boundary |
| --- | --- | --- |
| Workspace readiness | Bounded ALG.workspace.json registry, scoped document/fact/skill requirements, known/unknown/stale/conflict states | Ordinary tool use remains advisory; mandatory enforcement covers qualified managed investigation dispatch only |
| Skill applicability | Existing skill loading and application-level approval policy, exact approved closure and current scope | No automatic trust escalation, silent repinning, or new measured-promotion policy |
| Investigation state | Independent durable ledger, typed session pointer, bounded hypothesis/evidence/checkpoint records | Bulk data and the large knowledge map remain in datalake-mcp |
| Remote work recovery | Work identity, durable admission and reservation, unknown-outcome lookup, fresh result validation | Deduplication applies to the managed route with a qualified service, not arbitrary direct MCP calls |
| Compaction and task changes | Bounded projection in normal/compaction hooks; restart reconciliation; durable task-detachment intent | A summary is a projection, never the only copy of investigation state |
| Research graph | Fixed data-investigation graph with bounded fan-out and fresh checking | No recursive orchestrators or automatic graph rewriting |
| Analytical authority | Reported analytical outcome separate from execution completion; engineer review binds the exact evidence before confirmation | Model output and execution success do not establish causal truth or remediation authority |
| Deployment | Platform-specific prepared bundle, pinned Git object bytes, exact dependency inventory, approved manifest, existing transactional manager | Dependencies are prepared before transfer; deployment is offline; runtime and host versions are checked |
| Local acceptance | Windows PowerShell and native Ubuntu Bash in dedicated WSL; deterministic local provider and official MCP SDK fixture | No GitHub runners, paid model calls, production queries, or user-global config changes |

## Operator entry points

See [V1 investigation usage](v1-investigations.md), [deployment](deployment.md), and [headless acceptance](v1-headless-testing.md). Workspace and investigation features are opt-in. Enabling an adapter requires a qualified service profile with the actual endpoint's schemas and behavioral evidence; the synthetic test profile is not a production approval.

The single Bash deployment command uses an already prepared bundle and a separately reviewed manifest digest:

```bash
bash "/path/to/opencode-alg/scripts/alg.sh" deploy --offline --trust-bundle <reviewed-manifest-sha256>
```

Use isolated --config-dir and --install-root overrides when evaluating a candidate. A successful deployment means installed on disk; an existing OpenCode process must restart before it loads the new generation. The new candidate writes state older 0.5.0 schemas do not understand, so rollback to that version is rejected.

## Remaining qualification and later milestones

Local acceptance results are recorded separately with exact commits and evidence identities. An interrupted or failing test run is not a pass, and a source-checkout run is not a packaged-installation run.

The real air-gapped datalake-mcp service has not been inspected or qualified. Deployment there still requires its schema/identity, caller scope, submission lookup/idempotency, execution limits, retention and result validation probes. WSL qualifies the tested Ubuntu environment; it is not evidence for every native Linux distribution or libc.

The broader design's 11,000-entry discovery-scale fixture and curated semiconductor incident cases remain unqualified. The local host fixture creates the fixed graph and exercises its managed query route; it does not run the complete specialist graph or establish defect-attribution accuracy. Twenty reconstruction cycles are covered by deterministic store/runtime tests; the packaged host check measures one actual compaction and two process restarts. These are distinct evidence levels, and the PR does not claim every design acceptance row is closed.

Measured skill promotion, curated outcome cohorts, optional artifact-building skill qualification, graph selection/improvement, recursive graph authoring, and shared multi-user knowledge remain subsequent V1 milestones. OpenCode V2 implementation remains excluded.

## Local acceptance — 10 November 2026

Implementation under test: `395fd234365ab2d44797c48dac86b224fff2f82a`. These are engineering acceptance results, not production datalake or model-quality results.

| Check | Measured result |
| --- | --- |
| Native Ubuntu full Bun suite | 1,028 passed; 13 Windows-only skips; zero failures; 11,014 assertions across 75 files (456.95 seconds) |
| Windows immutable broad suite at 7ac73c1 | 1,032 passed; five platform skips; two failures; 11,112 assertions across 74 files (2,828.77 seconds). The failures were the stale legacy-version fixture and package allowlist, both corrected and passed in the focused runs below; this older suite is not relabeled green |
| Windows affected deployment/package/host tests | 96 passed; one Linux-only skip; zero failures; 579 assertions |
| Windows targeted legacy compatibility and journal repair | Two passed, including the earlier timed-out case |
| Windows and Linux deployed packages | Real OpenCode server and TUI registration passed on both; global-config snapshots unchanged; processes and temporary host environments cleaned |
| Windows and Linux deployed headless investigations | Each: OpenCode 1.18.35; 21 ALG tools; one real host compaction; two server restarts; three query results; one accepted synthetic MCP job; three fresh result validations |
| Linux bundle relocation | Prepared, relocated and installed inventories identical: 11,561 entries; production dependency identity covers 10,052 files / 126,621,871 bytes |
| Windows bundle relocation | Prepared, relocated and installed inventories identical: 11,595 entries; production dependency identity covers 10,104 files / 126,814,922 bytes |
| Linux manager lifecycle | Single-command Bash deploy; repeated deploy unchanged; compatible rollback and reactivation; doctor clean; restart acknowledgement only after fresh-host verification |
| Windows manager lifecycle | PowerShell deploy; repeated deploy unchanged; doctor clean; custom config/comment and custom agent preserved; restart acknowledgement after fresh-host verification |

Test environment: Bun 1.3.14 and OpenCode 1.18.35 on both platforms; PowerShell 7.6.9 / Node.js 22.17.0 on Windows; Ubuntu 24.04.5 in dedicated WSL 2, Bash 5.2.21, Node.js 22.23.4, glibc 2.39 and uv 0.9.13 on Linux. The plugin does not require WSL in deployment; WSL provides the local native-Linux test environment.

The Windows deployment step took 687.12 seconds and the verified no-op redeploy took 325.05 seconds while the broad regression suite also ran. Both scan the complete bundle inventory. These are observed acceptance timings under concurrent filesystem load, not isolated installation-performance benchmarks; no fast-install claim is made.

Linux bundle approved manifest: `3d9fdc6365c0cdcd182cc70671aa3739b5c1d2cfb9a8601bc8fa34a474efc6d9`. Windows bundle approved manifest: `3664292eb1e2a67749e9f90544931086c9b42101952e1556b1a72527e916bd40`. Both name the implementation commit above. The loaded package runtime digest is `2049e6676828a618e0c03e29346ef529c748e2b51f12590886b719282a0561f0`; package inventory and runtime identity are separate measurements.

Initial failures were preserved and corrected, not relabeled as passes. They exposed POSIX npm layout handling, Linux inode reuse, Bash test invocation, package inventory/mode expectations, Linux startup-log quoting, missing/canonical test executables, and Windows npm-wrapper host discovery. One early Windows suite ran while implementation was still changing and is provisional only; the subsequent immutable run and targeted corrections are accounted separately.

Terminal headless receipts: Windows SHA-256 `1a726644d83c5e758acfb68af7d832be726f922905803ad75c2592cfa1de84fa`; Linux `729796b5df300bcd398865632ef452642fc48bcc9371e88bd41780a91dfb5a7b`. Server/TUI receipts: Windows `b45b1bd104c2922c327b0260a0dab1613b5ac2b57b4d9f18fc12adf7556db860`; Linux `9c5d9a96ecb844a4fcb53928815d1e24b03b1d22ad337a98ab057d5be7e2521a`.

Full local receipts remain outside the repository under the task's implementation-evidence directory and /home/algtest/alg-v1-evidence in the dedicated distro. Only the final headless JSON file is terminal evidence; its .before-cleanup.json companion records the preceding phase. The dedicated test distro, prepared bundles and isolated managed installations are retained for review; temporary host environments were removed. No hosted model calls or GitHub runner tests were used. The bounded host check does not establish a multi-hour soak, scientific correctness, or production endpoint qualification.

Subsequent acceptance-status commits change documentation only. The prepared packages and all runtime identities above remain bound to `395fd23`; they are not relabeled as packages built from a later documentation commit. The PR remains open and unmerged.

## PR review disposition — 10 November 2026

The external review reproduced meaningful defects. Three new regression probes first failed against the prior candidate: decimal reservation settlement, terminal cost overrun, and failure to release a proved-unaccepted reservation. Those receipts remain preserved. The earlier broad-suite and packaged receipts above belong to 395fd23, not to these fixes.

| Finding | Disposition |
| --- | --- |
| Floating-point reservation mismatch | Fixed: arithmetic and equality use safe integer millionths; unsupported reservation precision is rejected before admission. Finer service billing is preserved exactly on the work receipt and conservatively rounded up only for the cumulative charge |
| Local failures become uncertain remote jobs | Fixed: transport errors carry a trusted transmission stage; only potentially dispatched calls retain uncertainty and reservations |
| Cost above reservation loses terminal outcome | Fixed: persist terminal result/cost, release active reservation, record a budget breach and block further spend |
| Model-controlled identity creates duplicate work | Fixed for host-owned purpose/generation, equivalent ISO as-of instants and unused descriptive parameters. Arbitrary semantic query equivalence remains unqualified |
| No delegated work-order boundary | Added explicit orchestrator admission and node assignment; children execute only an admitted key for their active node. Checker purpose is host-selected and cannot share a normal-analysis assignment |
| No operator recovery | Added atomic operator abandonment of unsubmitted/terminal work and explicit retry of proved zero-cost nonacceptance. Unknown or potentially running work cannot be silently released |
| JSON embedded in strings and generic errors | Replaced with a strict typed request union and bounded fixed-code/safe-path diagnostics |
| Starter phases never match | Corrected the starter to the implemented execute phase; it remains a reviewed example, not automatically installed team policy |
| Service contract chosen before qualification | Agreed. The HTTP implementation is a reference protocol. The production translation must follow inspection of the actual service |
| No bounded result-content reader; no autonomous long-job continuation | Still merge blockers for a complete investigation workflow. Manifests and explicit resume are not substitutes |
| Service upgrades strand reuse | Metadata remains locally inspectable; current access/reuse remains pinned deliberately. A qualified revision migration/revalidation path is missing; silently accepting drift would be incorrect |
| General operation detection and fact sources | The fixed template already derives its operation. General Git/test detection and authoritative fact resolution remain incomplete; environment identity alone does not supply those facts |
| Another persistence format | The ledger already reuses mutex, canonical JSON, contained paths and atomic publication. Further consolidation should preserve its independent lifetime and recovery semantics |
| Repeated deployment hashing | Worth profiling. Concurrent Windows acceptance timings alone do not justify removing integrity/race checks |

The service-specific recipe/parameter normalization, bounded result reader, job-status continuation, revision migration, authoritative fact resolvers, complete real-model specialist graph, 11,000-entry catalog fixture and curated incident evaluation remain explicit acceptance work. No percentage or production-readiness claim is made. Graph-policy generalization follows the next graph-selection milestone; it is not required to fix these ledger defects.

Candidate 0.5.1 makes the new durable fields visible to manager compatibility checks; older 0.5.0 readers must not be activated against this state. Existing pre-fix ledger identities are not silently reinterpreted: inspection and reconciliation remain available, but further admission requires an explicit migration decision.
