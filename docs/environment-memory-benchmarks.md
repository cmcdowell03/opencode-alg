# Environment memory benchmark and soak

Run the harness explicitly with Bun. It creates a seeded, synthetic graph,
commits bounded entity updates to local SQLite, reopens the engine at the
configured restart interval, replicates to a local directory object store, and
restores into an empty local engine. It does not initialize S3, call a model, or
discover real hosts or services.

~~~powershell
bun run scripts/environment-memory-benchmark.ts --seed=71 --events=12 --graph-size=16 --restart-frequency=4 --duration-seconds=0
~~~

Arguments use --name=value:

| Option | Default | Bound and meaning |
| --- | ---: | --- |
| seed | 1 | Integer from 0 to 2,147,483,647; controls fixture updates and bounded latency sampling. |
| events | 100 | Maximum workload commits, from 1 to 10,000,000. |
| graph-size | 64 | Synthetic entity count, from 10 to 5,000. The fixture includes a PC, pod, gateway, two APIs, repository, deployment, database, and two principals. |
| restart-frequency | 25 | Reopen the SQLite engine after this many workload commits; 0 disables periodic reopen. Final snapshot recovery still runs. |
| duration-seconds | 0 | Stop workload commits at this elapsed limit, from 0 to 259,200 seconds. 0 disables the duration limit. |
| output | stdout | Optional JSON output path, for example --output=artifacts/environment-memory-24h.json. |
| keep-artifacts | temporary | Optional directory for retaining the SQLite files, local object store, and benchmark.json. |

The event count and duration are independent stop bounds. The report includes
stop_reason, duration_target_met, actual elapsed time, and completed event
count; a run that reaches its event cap before the requested duration is not a
completed duration soak. A 24-hour run can be started with:

~~~powershell
bun run scripts/environment-memory-benchmark.ts --seed=20260923 --events=10000000 --graph-size=128 --restart-frequency=1000 --duration-seconds=86400 --output=artifacts/environment-memory-24h.json --keep-artifacts=artifacts/environment-memory-24h
~~~

A 72-hour run uses the same bounded workload with the maximum duration:

~~~powershell
bun run scripts/environment-memory-benchmark.ts --seed=20260923 --events=10000000 --graph-size=128 --restart-frequency=1000 --duration-seconds=259200 --output=artifacts/environment-memory-72h.json --keep-artifacts=artifacts/environment-memory-72h
~~~

Both commands permit early termination at the 10-million-event cap. Confirm
duration_target_met: true before describing a result as a 24-hour or 72-hour
run. These are invocation examples, not validated long-soak configurations:
the current 16 MiB snapshot ceiling includes historical idempotency receipts,
so a high-event run may fail capacity validation at final replication. A
successful 24/72-hour result requires an executed run within that ceiling or a
separately reviewed retention/checkpoint design. Event history and retained
artifacts use disk space; choose a destination with capacity appropriate to
the run. high_water_rss_bytes is the maximum RSS
sampled every 128 workload commits and at completion, not continuous tracing.
Commit, query, and recovery percentiles are computed from deterministic reservoir
samples capped at 2,000 values per metric; the sampled raw milliseconds are
included in the JSON. Recovery samples cover process-engine reopen and final
snapshot-plus-journal restoration.

The report records the Git HEAD revision and whether the working tree is dirty,
the runtime identity, full run configuration, setup and workload operation
counts, elapsed times, commit/query/recovery p50 and p95, sampled RSS, SQLite and
object-store bytes, cache size/capacity/evictions, replication lag, retained
fact counts, and structural route/permission reference violations. These
synthetic claim counters check fixture references and principal IDs; they do
not establish real-world reachability, authorization, or safety.

## Provider-paired evaluations

This CLI has no model-provider option and does not make model calls. A provider
comparison must therefore be run by a separate harness that records the actual
provider and model identifiers. Keep the fixture seed, graph, event sequence,
restart schedule, prompt/input set, and evaluation criteria fixed across each
pair; record provider-specific settings, call counts, elapsed time, failures,
and costs in that harness. Pair runs by fixture and input identity, and report
those external measurements separately from this storage benchmark. No
provider-paired evaluation was run for this implementation.

## Short smoke evidence

On 2026-09-23, the command shown at the top was run from the clean implementation
commit. It completed 12 workload commits against
a 16-entity, 9-relation graph, with 25 fixture setup operations and 3 engine
reopens. It took 73.03 ms for the event workload and 151.42 ms from workload
start through local replication and restore. The duration bound was disabled,
so this is a smoke result, not a soak.

| Measurement | Result |
| --- | ---: |
| Commit latency p50 / p95 | 1.8426 / 2.9201 ms (12 samples) |
| Query latency p50 / p95 | 0.4168 / 4.5796 ms (12 samples) |
| Recovery latency p50 / p95 | 8.4678 / 11.8071 ms (4 samples) |
| Sampled RSS initial / high-water | 101,330,944 / 116,654,080 bytes |
| SQLite / local object-store bytes | 192,568 / 25,484 bytes |
| Cache entries / capacity / evictions | 0 / 128 / 0 |
| Replication lag at completion | 0 revisions |
| Retained entities / relations | 16 / 9 |
| Structural route / permission violations | 0 / 0 |

The report identified Bun 1.3.14, Bun's Node compatibility version v24.3.0,
Windows x64, source revision
9a2aea9b67e88620c7fd8b3227092657ec3122a9, and working_tree_dirty: false.
These measurements identify that clean implementation commit; this evidence-only
documentation update does not change the measured code. The small run is not
evidence for a long-duration soak or production performance.
