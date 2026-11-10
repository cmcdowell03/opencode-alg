# ALG V1 Linux/Bash Acceptance and WSL Environment

Draft dated 9 November 2026. Required Phase One portability coverage for the OpenCode 1 host. WSL 2 is the Linux virtualization platform; it does not imply OpenCode 2 work. The [design index](alg-v1-design-index.md) owns sequencing and the [Phase One plan](alg-v1-phase-one-investigation-plan.md) owns investigation semantics.

## Current status and scope

Machine inspection found WSL 3.0.3.0, kernel 6.18.54.1-1, with default WSL generation 2. The only registered distribution was docker-desktop, stopped. The WSL catalog offers Ubuntu-24.04. No dedicated ALG Linux environment has been provisioned, and no Linux plugin tests have run.

Use a separate Ubuntu-24.04 WSL 2 distribution named ALG-V1-Ubuntu as the first Linux/Bash target. Windows/PowerShell remains a required regression lane. Both use the same ALG source revision, fixture definitions and acceptance assertions, with explicit platform expectations. Only the exact tested OpenCode 1 patch and runtime/dependency versions are qualified. Pin an additional minimum supported V1 patch only if the release makes that compatibility claim; never resolve an unqualified latest host that might install OpenCode 2.

WSL results qualify the named Linux distribution under WSL. They do not establish native-server, container, Kubernetes, ARM64, other-libc or other-distribution support. Reuse the same Linux acceptance entry point on the actual deployment environment before extending that claim.

## Environment setup deliverable — Phase 1a

1. Create the dedicated distribution without altering Docker Desktop, the default distribution or global WSL settings. Keep its virtual disk in a task-owned location such as D:/alg-test-env/wsl/ALG-V1-Ubuntu after checking available storage and name/path collisions. The installed WSL supports named distributions and explicit locations. An installation example for this machine, not executed by this document, is:

   ```powershell
   wsl --install -d Ubuntu-24.04 --name ALG-V1-Ubuntu --location D:\alg-test-env\wsl\ALG-V1-Ubuntu --version 2 --no-launch
   ```

   Record the acquired image identity and checksum where available. Provision a dedicated non-root test user; use elevated privileges only for initial package setup.

2. Put the checkout, dependencies, run stores and evidence under a task-owned Linux directory such as /home/algtest/alg-v1. Use the Linux filesystem for the primary lane, not /mnt/c or /mnt/d. A Windows-mounted directory is a separate interoperability check. This follows Microsoft's guidance for Linux file workloads and avoids conflating Linux and mounted-Windows filesystem behavior. [WSL filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems)

3. Install Linux builds of the repository-declared runtimes and the pinned OpenCode 1 host. Verify each executable's resolved path and platform; a Windows executable found through inherited PATH cannot count as a Linux pass. Prepare Bash, Git and the existing test/build dependencies only. Capture OS, architecture, libc, kernel, Bash, host, runtime and lockfile identities. Do not copy Windows node_modules or native binaries.

4. Use the test user's isolated configuration and credential store, empty of personal/global plugin state. Validate actual OpenCode configuration discovery before testing precedence. Keep process PATH scoped to Linux test tools; qualify both fresh interactive Bash and non-interactive launches. Do not edit the Windows profile or repurpose the operator's home directory.

5. Reuse existing synthetic fixtures and a bounded fake of the qualified datalake-mcp contract. Keep accepted-job counts and server receipts independent of ALG's own status. Start with same-distribution loopback or the declared local transport, recording the route. Qualify cross-host/network routes separately when needed; do not assume Windows localhost forwarding proves production connectivity.

6. Produce a repeatable setup recipe, a version manifest and an environment-readiness receipt. Setup completion means the Linux tools and isolated host can start; it is not a plugin acceptance pass. Use only official or approved package sources and pinned manifests. Setup downloads and offline acceptance are separate stages.

Microsoft documents distribution selection and WSL 2 installation. Per-distribution configuration differs from global WSL configuration, and a global shutdown affects other distributions. Scope any restart to the dedicated test distribution and preserve evidence first. [Installation](https://learn.microsoft.com/en-us/windows/wsl/install), [configuration scope](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)

## Single-command Bash deployment

Phase One must ship one supported Bash entry point for deploying a prepared ALG release. WSL environment provisioning is separate; once the compatible OpenCode 1 host and declared Linux runtime are available, installation must not require manual configuration edits, dependency commands or agent-file copying.

Proposed interface, not a currently implemented command:

```bash
bash ./opencode-alg/scripts/alg.sh deploy --offline
```

Run this from the parent of an extracted, approved release directory named opencode-alg; the path may be absolute or different, and must be quoted when it contains spaces. Resolve package content relative to the launcher, never the caller's current directory. The release manifest pins the package revision, dependency closure and target platform. The default destination is the invoking user's resolved OpenCode configuration; reuse existing --config-dir and --install-root overrides for isolated tests or a different destination.

An explicitly connected deployment may use the same proposed action with --version <exact-stable-version> instead of --offline. It resolves only through the configured trusted release source and records the exact commit and artifact identity. No implicit main, latest or host-major upgrade. The single-command guarantee begins with an available reviewed launcher/bundle; it does not claim that a bare operating system or an unprepared source ZIP is ready.

### Reuse the installer

The pinned baseline already has scripts/alg.sh forwarding into the TypeScript manager, with install, update, doctor and rollback, immutable generations and a transaction journal. Add a thin deploy action in that manager rather than another installer, configuration editor or release store. The shell launcher can remain POSIX-compatible while being invoked and tested through Bash. [Existing launcher](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/scripts/alg.sh), [manager contract](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/upgrades.md)

Current managed source installation requires a clean tagged Git worktree; the air-gapped guide instead describes prepared extracted packages. The missing implementation is a versioned, verified bundle input to the same manager transaction. Preserve the existing Git-source checks rather than pretending an archive contains a valid Git worktree. The source-specific validator must provide equivalent package, ownership and provenance inputs before shared activation. [Current disconnected deployment](https://github.com/cmcdowell03/opencode-alg/blob/99b88cd051cdff2ac30eff81b5a927d76a826efe/docs/air-gapped-deployment.md)

### Required command behavior

1. Preflight Bash/platform, writable destination, compatible OpenCode 1 and declared runtime; inspect prior receipt and unresolved transactions. Report missing prerequisites before touching active registration. No automatic sudo, runtime/host replacement or shell-profile edits.
2. Verify the release inventory, target architecture/libc and compatible state schema; validate dependency versions, bytes, links and modes. Authenticate the bundle using the site's approved release identity or verification mechanism. A checksum stored only inside its own bundle detects corruption but does not independently establish trust. Offline mode uses the fully prepared Linux dependency closure and makes no network requests or package-manager fallback.
3. Reuse immutable staging, lock/fencing, no-clobber publication, configuration preservation and managed-agent policies. Perform local dependency/import diagnostics before activation. Select fresh install, exact-generation no-op or compatible update from the external receipt; preserve unrelated plugins, credentials, policy, skills and run history. Legacy direct installs or custom registrations require an explicit reviewed adoption path, not silent overwrite.
4. Commit through the shared recoverable transaction, then run existing local doctor checks and write a bounded receipt. Interrupted or concurrent deployments must reconcile or fail clearly without exposing a mixed registration. Repeating the same command is idempotent; no repeated dependency provisioning or duplicate registration.
5. Print exact installed identity, destination, verification result and restart requirement. Distinguish installed-on-disk from verified-in-a-fresh-host. Preserve active sessions; do not kill/restart OpenCode or trigger paid model calls. Installation success may require an operator restart before the new code is used. Never label an unobserved host reload as successful.
6. Retain the previous compatible generation and existing rollback interface. Installation rollback must not roll back or delete investigation/run data. A newer durable-state format may make an old generation ineligible; check compatibility again and block unsafe downgrade. Errors retain evidence and return nonzero; successful install/no-op returns zero with explicit pending-restart status where applicable.

Optional capabilities and new routing remain governed by the existing opt-in/application policy. Deploying a skill file does not automatically approve it as trusted. Incompatible or missing offline dependencies must name the preparation gap without downloading replacements.

### Deployment acceptance

Test through this exact command, using a clean account and the distributable rather than a development checkout:

- Fresh offline install with external network disabled and no Git metadata; invoke from another working directory and a path containing spaces.
- Repeated same-release install, compatible upgrade and rollback; retain custom agents/configuration, unrelated plugins and durable investigations.
- Wrong platform, missing dependency, altered inventory, unsupported host major, unauthorized bundle identity and unavailable write permissions; active installation remains unchanged.
- Two concurrent invocations and interruption at every manager transaction boundary; recover via the same entry point and retain original failure receipts.
- Upgrade while an old host is running; report pending restart, preserve that session, then verify the new package in a fresh headless/TUI host.
- Legacy or custom installation, stale transaction and incompatible-state rollback; explicit blocker rather than destructive adoption.
- Connected exact-version resolution under the same transaction where that mode is shipped; no success claim based solely on offline fixtures.

The release gate requires the one-command offline path on Ubuntu/Bash. Windows continues using its existing launcher over the same manager implementation and must pass the shared deployment regressions. Add the Bash launcher and every required offline asset to the actual package inventory; installation documentation must copy the command exercised by acceptance.

## Required local test matrix — Phase 1a/1b

| Area | Cases and required evidence |
| --- | --- |
| Clean installation | Invoke the single supported Bash deploy command against the actual prepared distributable in a fresh test-user workspace without access to the source checkout. Verify plugin and agent discovery, configuration precedence, exact loaded revision, and a clear diagnostic for missing dependencies |
| Bash and command gates | Fresh login/interactive and non-interactive Bash; explicit working directory; spaces and Unicode in paths; quoted arguments, variables, pipes and redirection; nonzero exits and bounded stdout/stderr. Use the existing supported shell selection; record the actual gate executable and arguments. Bash invocation must be explicit where required; /bin/sh or Git Bash is not evidence of Bash execution |
| Failure honesty | A failing pipeline must fail when the declared validation contract requires all stages to pass; preserve the actual exit status through logging. Reject incompatible Windows-only gate syntax before spending model calls where existing preflight can identify it. Do not silently translate commands or globally change shell behavior to make fixtures pass |
| Files and paths | LF/CRLF and script shebangs, executable bits, case-sensitive imports and names, file URLs, spaces, relative/absolute paths, contained symlinks and escaping symlinks, non-root read-only files and denied writes. Preserve exact instruction hashes; newline conversion must not silently retain approval of different bytes |
| Skill lifecycle | Missing workspace requirements, approve/load under delegated policy, complete procedure delivery, source drift, revocation and scoped permissions. Test the same model-agnostic assertions used on Windows |
| Recovery and concurrency | All Phase One crash-window fixtures; twenty synthetic compactions and two OpenCode process restarts; stale locks, concurrent equivalent work and a failed child response after completed compute. Preserve skills, investigation identity, results, unknown submissions and budget; no extra accepted jobs |
| Process lifecycle | SIGINT, SIGTERM and forced OpenCode termination in controlled fixtures; child-process cleanup, timeouts and port release. Retain or reconcile remote work after host loss. Distinguish OpenCode restart from a dedicated-distribution restart; restarting the service with the client cannot prove recovery of an independently running remote job |
| MCP failures | Qualified local transport reconnect, delayed response, disconnect after acceptance, expired result, permission change and cancellation without terminal acknowledgement. No fresh submission merely because a response or session was lost |
| Package relocation/offline | Build or assemble a Linux-target package, move it to another Linux path and test account, and verify inventory bytes, intended file modes, symlinks and Linux native dependencies. Run with external network access disabled after preparation; local synthetic services may remain available. A source ZIP without dependencies is not an offline-ready bundle |
| Host surfaces | Headless server/session startup and one real TUI smoke in a pseudo-terminal, including visible child sessions, cancellation and continuation. A successful version command alone does not establish plugin loading or tool execution |
| Resource accounting | Record elapsed time, memory high-water mark and endpoint samples, disk growth, process/port cleanup and accepted jobs. Compare fixed workloads; do not infer a leak or absence of leaks from one sample |

Shell coverage must include the actual ALG gate implementation and host tool path, not only an external Bash wrapper around the unit suite. Preserve old shell behavior unless a separately reviewed change is needed.

## Execution order and evidence

Run existing applicable tests under Linux first, then targeted portability and recovery cases, then package relocation and host startup/TUI smoke. Reuse repository test commands and fixtures; do not create a parallel test framework or duplicate the scheduler/MCP analytics.

Keep deterministic tests independent of model credentials. Exercise actual OpenCode hooks where possible, and label direct-hook simulations separately from host-triggered compaction. A bounded real-model smoke on Linux remains necessary before claiming Linux model/tool behavior: declare its call, token, time and compaction/restart budgets before execution, use synthetic or approved data, and use the same tests for any configured provider. Do not inherit the earlier Windows eight-hour soak as authorization for another paid soak.

Every lane writes a receipt with exact source/package/runtime identities, filesystem and shell, command and working directory, fixture identity, timestamps, exit status, passed/failed/skipped counts and evidence pointers. Failures and interruptions remain visible; no shell logging pipeline may mask an exit code. Keep credentials and raw auth files out of logs and packages.

Preserve evidence before cleaning up only the test's identified processes and temporary credentials. Never use a blanket WSL shutdown or unregister another distribution as test cleanup.

## Release gate and limitations

Phase One portability requires both Windows/PowerShell and Ubuntu/Bash results for the same candidate revision, including the single-command deployment path, skill/context lifecycle, managed-job recovery and relocation. A missing Linux lane is not a warning-only pass. Failed or unrun cases keep the corresponding claim open.

The primary Linux gate runs on the Linux filesystem. Mounted-Windows interoperability is reported separately and cannot substitute for it. Native deployment acceptance remains open until the same recipe passes on the actual target. No GitHub runners, production queries, new analytics engine, model-specific logic or OpenCode 2 work is introduced.
