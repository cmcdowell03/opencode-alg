# Air-gapped deployment and configuration

This guide covers deployment from an already available source ZIP or package
archive. ALG does not need Git metadata at runtime. A source ZIP is not a
self-contained distribution: it needs compatible dependencies provisioned in
advance. In a disconnected environment, reuse the site's approved dependency
cache or pre-provisioned runtime; do not rely on installing packages from an
online registry.

## Configuration

OpenCode SDK plugin options continue to work. If a plugin section is supplied
by OpenCode, that entire section replaces the same section from the sidecar;
sections absent from SDK options can come from the sidecar. Both inputs are
validated against ALG's strict options schema. No opt-in feature is enabled by
default.

ALG checks these files relative to the loaded package root, never the current
working directory:

1. `alg-plugin-config.json` at the package root.
2. Legacy `src/alg-plugin-config.json`, only when the package-root file is
   absent.

If both default locations exist, startup fails with an ambiguity error. To use
another file, set `OPENCODE_ALG_CONFIG` to its absolute path. A present file
must be valid JSON, no larger than 64 KiB, and a regular non-symlink file.
Malformed, unsafe, or schema-invalid files fail closed; diagnostics do not
print configuration values. Do not include credentials in plugin options or
the sidecar. Keep credentials in the host's supported secret mechanism.

Create `alg-plugin-config.json` from this example and set only the sections
needed for the deployment:

```json
{
  "sessionMemory": {
    "mode": "off"
  },
  "skillEvolution": {
    "enabled": false
  }
}
```

Local sidecars at the package root and legacy `src/` path are ignored by Git
and excluded from npm packaging. The shipped package contains no live config.

## Offline diagnostics

From the extracted package root, with compatible dependencies already present, run:

```sh
bun --no-install run scripts/offline-diagnostics.ts
```

Run the script from each package being checked; it does not accept a different
`--root` because that would mix this script's parser with another package's
source digest. The command performs local parser fixtures, computes the current
package source-manifest digest, validates the selected sidecar, checks exact
declared dependency versions, and imports the server and TUI entries. It uses
no network, Git, models, OpenCode process inspection, or writes. It does not inspect live
OpenCode registrations or prove which code a running host loaded.

## ZIP deployment and restart visibility

Extract each release into a new versioned directory. Preserve the existing
configuration, state directories, and approved working dependencies. Do not
extract over an existing release tree. Verify the archive checksum or other
site-approved artifact identity, then run the offline diagnostics against the
new package directory.

Fully restart all OpenCode processes manually after changing the plugin source,
configuration, or package location. Sidecars are excluded from the source
digest: `restart_required=false` does not prove that a config edit was loaded.
ALG's startup log and
`alg_context_status.deployment` report a protocol/build identifier and a
bounded source-manifest digest computed at module evaluation, alongside a
separate digest of the current package tree. `restart_required` is true when
those two local observations differ, false when they match, and null when the
current tree cannot be measured. The field labels make clear that the
module-evaluation digest is not proof of upstream host loading: both values
describe the local package tree, and they do not establish which entry file the
host loaded or detect arbitrary source edits racing with startup. The offline
CLI reports disk identity only and never calls it a live runtime observation.

After a full manual restart, compare the fresh startup log and
`alg_context_status.deployment` values with the extracted package's offline
diagnostic report. Treat them as local consistency evidence, not as proof of
the cause of a host-specific loader failure. Preserve the prior release,
configuration, state, and working dependencies until the new deployment has
been reviewed in the target environment.
