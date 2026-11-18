# Lost raw test receipt

- Test command: the requested 14 migrated test files, Bun 1.3.14, `--timeout 60000`.
- Observed completed result before the next rerun started: 201 passed, 12 failed, 1,820 assertions, 170.81 seconds.
- The run was executed with elevated local filesystem access because sandboxed `linkSync` calls failed with EPERM.
- The prior `test-migration-after-schema.log` was overwritten/truncated when the next `Tee-Object -FilePath` invocation opened the same path. Its raw bytes are not preserved; this note records only tool-observed counts and failure names.
- Observed failures: architecture-audit merged model snapshot and shell overrides; graph-revision default graph and revision; investigation-planning legacy re-admission; investigation-workflow missing contract on reuse; plan-guidance empty preserve list and preservation error wording; reliability-observability compact/full run state after checker insertion; runtime-completion missing declared deliverable; shell-preflight gate override on an admitted contract.
- Corrections have since been made to the test fixtures/assertions where the new API behavior was clear. A new unique log path will be used for the next completed matrix run.
