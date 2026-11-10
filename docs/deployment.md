# Prepared offline deployment

The managed release manager accepts a relocatable bundle prepared for the same OS, architecture, libc identity, and launcher major version (Bun or Node.js) as the destination. The bundle uses the package's current semantic version for compatibility checks, but its identity is the immutable Git commit and artifact digest. A PR candidate has `release_tag: null` and the manager receipt labels its channel `candidate`; preparation does not invent a Git tag or copy `.git`, credentials, or manager/run state.

## Prepare

From a clean, committed source checkout on the target platform, prepare a new output directory while network access and npm are available:

```sh
bun run scripts/prepare-deployment.ts --source "/path/to/clean/opencode-alg" --output "/path/to/release bundle/opencode-alg"
```

Preparation reads the package's declared distributable files from the pinned Git commit (not live worktree bytes), runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, verifies production dependency resolution, then inventories every shipped path, byte hash, link target, mode, package lock, runtime target, source commit, and package version. It prints a manifest SHA-256. Keep that value in a separately reviewed release record. A checksum included in the bundle detects accidental changes; it does not authenticate the publisher.

Prepare with the launcher that will run deployment. Bun reports a Node compatibility version; that value is not the installed Node.js version. A Bun-prepared bundle records `runtime: bun` and its Bun major. A Node-prepared bundle records `runtime: node` and its actual Node major. Deployment rejects a different launcher or major version. To prepare with Node.js 22+, run `node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/prepare-deployment.ts ...`.

The prepared folder is relocatable within its declared target. The recipient must review the source commit, artifact digest, and manifest identity through an approved channel before approving its exact manifest hash.

## Install or update

With compatible OpenCode 1 and the selected launcher already installed, extract the prepared directory as `opencode-alg` and run from any working directory:

```sh
bash "/path/to/opencode-alg/scripts/alg.sh" deploy --offline --trust-bundle <reviewed-manifest-sha256>
```

Optional `--config-dir` and `--install-root` overrides use the manager's existing rules. Offline deploy verifies the exact approved manifest, complete package/dependency inventory, lockfile, runtime platform, installed production dependencies, OpenCode host version, source commit, and durable-state declarations before activation. It performs no network request and never invokes a package manager. It activates through the existing filesystem lock, immutable generation, receipt, and recoverable config/agent transaction. Each retained generation keeps the approved manifest for doctor and rollback verification. Custom config and agents are preserved by the existing managed/custom policy. Repeating the same bundle is a no-op. Fresh installs and updates retain the normal doctor and rollback commands; rollback remains subject to durable-state compatibility.

The 0.5.1 candidate added strict durable fields and an explicit identity-policy revision; its historical receipts and compatibility declaration remain unchanged. Candidate 0.5.2 adds durable investigation result-page and lookup-count fields. Its compatibility declaration includes 0.5.2, while 0.5.1 and older readers do not declare support for the new state, so rollback to those readers is blocked after 0.5.2 writes it. Older investigation ledgers remain available for inspection and reconciliation. Migration to a new qualified profile is an explicit operator action that preserves history and is rejected while a job is active or its remote outcome is uncertain.

`alg.sh` selects Bun when it is available, then falls back to Node.js. For a Node-prepared bundle on a host with Bun installed, invoke `node --disable-warning=ExperimentalWarning --experimental-strip-types "/path/to/opencode-alg/scripts/manager-cli.ts" deploy --offline --trust-bundle <reviewed-manifest-sha256>` explicitly.

On Windows PowerShell, use `& "C:\path\to\opencode-alg\scripts\alg.ps1" deploy --offline --trust-bundle <reviewed-manifest-sha256>` for a Bun-prepared bundle. For a Node-prepared bundle, use the explicit Node invocation above.

The manager discovers a native OpenCode binary on PATH, including the binary behind the standard Windows npm wrapper. It never executes Windows shell-wrapper text for host discovery. For a custom installation, set `OPENCODE_BIN` to the absolute OpenCode executable path. The version preflight is bounded to 30 seconds.

The result reports the full source commit, artifact and approved manifest digests, destination and pending restart. It means installed on disk. It does not attest that an already-running OpenCode process loaded the generation. Restart OpenCode yourself, then use `doctor --ack-restart` only after observing the fresh host.

Legacy direct installs or unrelated plugin registrations are not silently adopted. A conflicting/custom registration, malformed receipt, unresolved manager transaction, incompatible bundle, or unavailable destination fails before managed activation. Use `doctor` to inspect a prior transaction; use `doctor --repair-journal` only when the manager reports recovery is needed.

## Limitations

The bundle target is one OS/architecture/runtime target, not a universal archive. Prepare and test separately for Linux/Bash and Windows/PowerShell. Native optional capabilities such as the Excel Python environment are not installed by this V1 offline bundle path; bundles carry the declared package's production Node dependencies only. Connected exact-version deploy is not included in V1.
