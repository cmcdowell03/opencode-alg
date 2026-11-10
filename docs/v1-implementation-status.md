# V1 Phase One implementation status

PR [#14](https://github.com/cmcdowell03/opencode-alg/pull/14) contains an experimental local Phase 1a/1b implementation against main baseline 99b88cd. The current candidate is 0.5.2 and targets OpenCode >=1.18.0 and <2.0.0. It is not merged or released. Earlier 0.5.1 receipts and statements below remain historical evidence for their named commits and are not relabeled as 0.5.2 acceptance.

**Current disposition, 10 November 2026:** the earlier 80% estimate remains withdrawn. The confirmed ledger defects and the missing local workflow contracts are implemented. Native MCP translation is configurable and tested against fixtures, not verified against the real air-gapped datalake-mcp. The PR remains draft: local engineering results do not establish production service qualification, scientific usefulness or reliable autonomous session termination.

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

Use isolated --config-dir and --install-root overrides when evaluating a candidate. A successful deployment means installed on disk; an existing OpenCode process must restart before it loads the new generation. The new candidate writes state older 0.5.1 and 0.5.0 readers do not understand, so rollback to those versions is rejected.

## Current 0.5.2 acceptance — 10 November 2026

Runtime implementation and prepared packages: `d62812065e1d3b60cadce35385e1e620cb26f3a0`. The final follow-up changes documentation and moves isolated verification bootstrap inside its cleanup boundary; it changes no plugin runtime, agents or host permission policy. Packages are identified by their actual preparation commit, not by the follow-up commit.

| Check | Result and scope |
| --- | --- |
| Native Ubuntu full suite at a13c513 | 1,094 passed, 13 platform skips, zero failures; 11,332 assertions, 81 files, 1,057.76 seconds |
| Native Ubuntu follow-up at d628120 | 45 passed, zero failures; 452 assertions covering the later long-path mutex and isolated host bootstrap changes; type checking passed |
| Windows focused implementation checks | 93 passed, zero failures, 491 assertions across ten files; additional package/import, lock and qualification regressions passed. These overlapping sets are not a new full-suite count |
| Windows final verification-cleanup checks | 68 passed, zero failures; 192 assertions across live verification and headless harness tests |
| Windows source headless recovery | Passed: one actual host compaction, two restarts, one accepted asynchronous synthetic job, two job lookups, three query/read-result tool calls, one remote result-page read and six fresh validity checks |
| Native Ubuntu installed package | Passed: offline deploy/redeploy, exact relocated dependencies, the same headless recovery, server and TUI registration, preserved custom config and agent, clean process teardown and unchanged global config |
| Windows installed package | Passed on the D-drive follow-up: offline deploy, unchanged redeploy, exact relocated dependencies, installed headless recovery, server/TUI registration, preserved custom config/agent and complete cleanup; the first C-drive attempt timed out and remains failed |

Full-suite execution predates d628120 by the focused mutex/bootstrap delta; it is not represented as a full suite against the final commit. No model or production MCP is used by deterministic host acceptance. Both platforms run OpenCode 1.18.35 / Bun 1.3.14. Windows uses PowerShell 7.6.9 and Node 22.17.0; native Ubuntu 24.04.5 runs in the dedicated WSL distro with Bash 5.2.21, Node 22.23.4 and glibc 2.39. These observations do not qualify other host versions or every Linux distribution.

### Real-model outcome and limits

One bounded final local Gemma 4 8B Q4_K_M probe completed all seven fixed investigation nodes in seven attempts, including the exact engineer-review checkpoint and resume. The fixture contained no production data, qualified service or causal evidence. After that graph reached `done`, the model created a second graph despite instructions to stop, then the enclosing continuation hit its 240-second limit. **The overall session result remains failed.** This establishes a completed graph, not dependable session termination, scientific accuracy or a long-session soak. Completed run: `assess-the-input-completeness-of-20261110090422-825de10b8c9a`; the second run remains a preserved interrupted record. No further model attempts were spent to manufacture a pass.

This also bounds the duplicate-work claim: managed reuse protects work within the attached investigation. A model that explicitly creates a new independent plan can create a new investigation and budget; this PR does not deduplicate equivalent goals globally or guarantee that an orchestrator stops after completion.

The original model-test receipt reported incomplete cleanup. A separately timestamped escalated process census subsequently found all three owned parent IDs and their direct children absent; the original receipt remains unchanged. Global configuration snapshots matched.

### Deployment and evidence boundary

Both prepared bundles name `d62812065e1d3b60cadce35385e1e620cb26f3a0`. Linux manifest: `72e82f51241e41b78985064cd36c6059d0b23f48ee7f7f477b4a67d1c21900f4`; Windows manifest: `7a2383f92f233e06d5c80c4644734cd9da0ede6858aba92db59f44a8b4b54699`. Linux prepared/relocated/installed inventories match: 11,568 entries, including 10,052 dependency files / 126,621,871 bytes. Its installed runtime digest is `e069c0791feb7ca7f3afbaa94c95f0bf375aa84c0d405a9fb41ea73ea50f60d7`. Linux deployment took 42.723 seconds and verified no-op redeployment 25.319 seconds; these are acceptance observations, not isolated benchmarks.

| Retained receipt | SHA-256 |
| --- | --- |
| Linux installed headless | `7ff9d4e43d14170800156656c9a1dcaef6d9afc7a0c9b386eaa467118721579f` |
| Linux installed server/TUI, durable follow-up | `472b5df0930f57c23c15de9dc4fa97fb12fed38125ffcaf07737b0af4efe17c7` |
| Windows source headless | `e33b99c097b69f5995bfd0e160c6f8092060b153f806e612f7085d92380ea876` |
| Failed enclosing local-model session | `a4779201e4735ddfc84fecda8a3a64de6009588fc9e5fd1b04a8747fb160e6dc` |
| Separate local-model cleanup census | `0d2f6ed366e48dbe199f6fdbc7c20a1a1d6fba2b3649e961bd96430477b1c76d` |

Windows source-checkout runtime is `920784b15fdf71d8d1441a977b8e9d60c520c687bd2aee5699eba1b2834515ce`; checkout line endings and prepared Git-object bytes have distinct raw identities. The Windows installed runtime matches the Linux prepared runtime byte-for-byte: `e069c0791feb7ca7f3afbaa94c95f0bf375aa84c0d405a9fb41ea73ea50f60d7`. Its prepared/relocated/installed dependency identity matches across 11,602 inventory entries, including 10,104 dependency files / 126,814,922 bytes. Windows installed headless receipt: `ab51c3fc2d33ced62f890c21cb6b7e5609c981dd627c7146cc6b7c147fc9f0e3`; server/TUI receipt: `5aef731128aae9286c50c82c5006ca0ceec5f7f96b238abad74f8116be15b334`.

The first Windows attempt prepared the bundle in 731.946 seconds but exceeded its 900-second deployment limit before activation. Its configuration and custom agent remained unchanged, no activation receipt existed, and an escalated process census found the installer and direct children absent. Its original failed receipt is `1b4689cd7a9ad1cd5061286f829df8380125b0410ebe6e489748a52a4b59774f`; incomplete generation/staging files remain preserved. A single follow-up reused that exact bundle at `D:/alg-v1-acceptance-d628120-20261110`, with a 1,800-second per-step cap: deploy 808.768 seconds, unchanged redeploy 408.911 seconds, installed headless 35.892 seconds and server/TUI 12.538 seconds. Its aggregate receipt is `352a545e412e03b3d72a036f1975c603f653041dce40318d0633f0e786ddb702`. The changed path and allowance do not isolate a performance cause or turn the first timeout into a pass.

The Linux server/TUI check originally passed, but its raw temporary receipt was unavailable after the WSL invocation ended. Its original summary and hash remain preserved. A separate no-model server/TUI verification against the same installed package passed and retained the raw receipt under a durable evidence root; it is a distinct receipt, not a recreation of the original.

Production deployment requires an already installed and initialized OpenCode V1 host, including its host configuration dependencies. A fresh OpenCode 1.18.35 configuration may contact its npm registry before loading ALG. The test harness seeds only isolated test directories from the exact dependency fixture; the ALG offline bundle does not bootstrap an entire air-gapped OpenCode installation. Prepared bundles are platform-specific.

### Remaining qualification and later work

- Real datalake-mcp remains **UNQUALIFIED**. Its actual job API, idempotency/lookup, permissions, retention, source validity, bounds and behavior must be exercised locally by its operator. The qualification CLI inventories schemas and records probes; it deliberately does not issue production approval.
- Host-side waiting is bounded to 15 minutes, not a background daemon. Expiry or host shutdown requires explicit resume/reconciliation of the durable job.
- Recipes provide typed normalization for configured operations. An empty recipe list retains legacy explicit admission; arbitrary SQL equivalence and direct MCP calls are outside the duplicate-work guarantee.
- The 11,000-entry catalog and incident families are synthetic evidence/uncertainty fixtures. They do not establish semiconductor root-cause accuracy. The real-model session loop remains a visible autonomy limitation.
- Deployment performance still needs isolated profiling. This change preserves inventory/race checks; it makes no fast-install claim and does not remove hashing merely because a concurrent Windows run was slow.
- Measured skill promotion, autonomous graph authoring/improvement, shared cross-user knowledge and the wider V1 roadmap remain subsequent milestones. No V2 work began.

## V1 PR #14 implementation and acceptance checklist — candidate 0.5.2

This section records the current implementation scope separately from acceptance. It does not change any prior receipt, result, or commit attribution above.

### Implementation documented in this candidate

- [x] Durable result pages: at most 100 rows per request, capped by a global 16 KiB page limit and the qualified transport response size, with at most eight durable cached pages per result.
- [x] Revalidate source, access scope and retention before reusing a result or its cached pages; page identity includes the manifest, digest, scope, cursor and row bound.
- [x] Fixed reviewed recipe/version and typed parameter admission through `admit_recipe`; executable query construction and normalization stay host-owned.
- [x] Trusted local declarative MCP mappings for request and host JSON pointers, nested output fields, constants, and bounded discriminator-selected response cases.
- [x] Operator profile migration preserves ledger and evidence history and refuses active or uncertain remote jobs.
- [x] Host-side bounded continuation defaults to 30 seconds and allows at most 15 minutes. It is not a daemon; after expiry or process restart, an explicit run/resume or reconciliation is required. Durable lookups are capped at 1,000 per work item.
- [x] Requested workspace facts are resolved from bounded local sources; simple configured tool-command detection remains advisory.
- [x] Synthetic seven-node workflow covers an 11,000-entry catalog. This is fixture/integration evidence and makes no scientific or causal-accuracy claim.
- [x] Qualification CLI and its operator guide are separately packaged. A real air-gapped MCP service remains **UNQUALIFIED** until service-specific qualification is completed.
- [x] Package, npm lockfiles, durable compatibility list and release-gate version literals are advanced to 0.5.2. The rollback boundary prevents 0.5.1 readers from opening state after new durable fields are written.

### Acceptance disposition

See the current acceptance record above. Implementation and local engineering validation are tracked separately from actual-service qualification. The original failed and interrupted checks remain failed; no prior receipt is relabeled. No V2 implementation, GitHub runner use, merge or production/scientific claim is included.

<details>
<summary>Historical 0.5.1 acceptance and review record (unchanged)</summary>

## Historical 0.5.1 status and receipts — preserved snapshot

The status, open-items lists and receipts in this section are retained as recorded for their historical 0.5.1 candidate and named source identities. Statements that a capability or synthetic fixture was incomplete describe that earlier snapshot; the current 0.5.2 implementation checklist at the end supersedes them for implementation status. None of the historical receipts is relabeled as 0.5.2 acceptance.

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

Before the review fixes below, subsequent acceptance-status commits changed documentation only. The prepared packages and all runtime identities above remain bound to `395fd23`; they are not relabeled as packages built from a later documentation commit. The PR remains open and unmerged.

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

## Review-fix validation — 10 November 2026

The review fixes were committed as b3641d7; 4d259d3 adds conservative settlement of finer-precision service billing. Both are pushed to this draft PR. Candidate version is 0.5.1. The package/deployment receipts above remain historical 395fd23 evidence; they are not evidence for a new 0.5.1 bundle.

- Windows affected suite: 117 passed, one platform skip, zero failures, 827 assertions across 12 files. Follow-up legacy-identity/deployment fixtures: 14 passed, zero failures. The real-Git compatibility test exceeded its old 20-second fixture allowance; after increasing that fixture allowance to 60 seconds it passed in 21.43 seconds. The earlier timeout is retained.
- Native Ubuntu affected suite at b3641d7: 119 passed, zero failures, 833 assertions across 12 files (28.58 seconds); the targeted compatibility test also passed.
- Final cost-settlement regression on Windows at 4d259d3: 26 passed, zero failures, 110 assertions. The same 26 tests and 110 assertions passed on Linux in 2.97 seconds. TypeScript checking passed on both platforms.

A single bounded real local-model probe used the already installed Gemma 4 8B Q4_K_M through OpenCode 1.18.35, with no hosted model or production data. It created the fixed graph and completed discover/process/equipment with valid child outputs, then exceeded the 400-second initial-session limit while metrology was running. Reconcile, confirmation and checking were not reached; no operator review was recorded. This is a failed/incomplete probe, not a full-graph pass or an analytical-quality result. Its runtime was b3641d7 (digest b43e001a9d1d496aadf230cd2906239ed375ba860cbfed7daa6a935d133c3781). The original receipt reported incomplete process cleanup; a separately timestamped post-exit process census found both owned processes and their direct children gone. The global configuration snapshot was unchanged. The original result remains unchanged and failed.

The first revised deterministic Windows host check had a collector defect: it counted an admission response as a fourth query result. The collector now counts query actions only and retains failed query results; its regression passes. The original failing receipt remains preserved. The corrected check passed, and final runtime host receipts are recorded separately.

Final source-checkout headless acceptance at 4d259d395b2ac2fc4c9617f3e119af9b46e41246 passed on both Windows PowerShell and native Ubuntu Bash. Each ran OpenCode 1.18.35, exposed 21 ALG tools, admitted one order, returned three query results around one actual compaction and two restarts, accepted exactly one synthetic MCP job, and performed three fresh validations. All test services/processes stopped, temporary host environments were removed, no provider credentials were inherited, and global configuration snapshots matched. These checks load immutable snapshots copied from the checkout; they do not qualify new offline bundles.

| Final host receipt | Runtime digest | Receipt SHA-256 |
| --- | --- | --- |
| Windows | 43ec1bad8c7af3b23a94760b5aa7dc50bc5b21cadbbd2d6b7f800eb488adec5f | d9f2a75284e7d17aa6f3d72b832ce95dda8061c286aef3299d506dc0917ea37c |
| Ubuntu | ed57a5b108d65af10fcaa94b0100e2e6645e7de16882a0783b8e0e25f027f946 | 580fca1394dc103cd6305fbeffeac4764e993cea1798668d1ad2105bd2bd2bbf |

The checkout runtime digests differ because 77 of 118 runtime files have different line endings. An independent inventory comparison found all 118 identical after CRLF-to-LF normalization; the raw digests above remain the actual loaded identities. The failed local-model receipt is SHA-256 a0c5dbebe2e9b827c9fdf3c26adbacc47e3b626027762f747d070afbed91ae24; its separate cleanup follow-up is 475c8f54c615af503bfe29d7c347732a21c0047cdec3a2912c7b86990482861c. Focused test sets overlap and must not be added into a fictitious full-suite count. No complete new broad-suite, packaged 0.5.1 acceptance, full specialist-graph pass, service qualification or scientific usefulness result is claimed. No GitHub runners, V2 changes or merge occurred.

</details>
