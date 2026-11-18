# V1 factory investigation handoff benchmark

Two synthetic incidents have identical crude defect rates of 30% for chamber A and 10% for chamber B. In one incident the 20 percentage-point difference persists within each product and inspection revision. In the other it disappears after matching. The first calls for a balanced chamber crossover. The second calls for validating the inspection revision. Neither incident establishes physical causation.

Each incident runs under three controller configurations.

| Configuration | What the recipient has after handoff |
| --- | --- |
| Native OpenCode Build | Project files, the public recovery skill and access to the accepted job |
| Build with ALG memory | The same materials, a scoped handoff note and a bound recovery skill delivered by ALG's system hook |
| ALG graph | The scoped materials and a recorded producer submission, followed by ownership transfer and a separate continuation node |

The scorer compares the saved numeric answers and proposed measurement with the matched case. It verifies that the recipient read the expected CSV bytes before writing its answer. A loopback service records the order and revision of lookup and read operations and counts submission attempts. The answer must cite the manifest reference returned by that service for this run. A persisted delivery receipt records which skill the plugin emitted. The local deterministic provider can also observe the text it actually received. Handoff exposure and compaction exposure are separate measurements.

## Run locally

Use an empty working directory for generated evidence. From the repository root, choose an existing evidence directory and run the scorer controls. Each output file must be new.

```sh
bun scripts/comparative-benchmark-qualification.ts <evidence-dir>/qualification.json
bun scripts/comparative-benchmark.ts --output <evidence-dir>/fixture.json
```

For the headless integration run, install OpenCode V1 and create a JSON file with these fields. Set `hostExecutable` to the absolute path of the local executable and `outputRoot` to a directory that does not yet exist.

```json
{
  "hostExecutable": "/absolute/path/to/opencode",
  "outputRoot": "/absolute/path/to/evidence/headless",
  "qualificationPath": "/absolute/path/to/evidence/qualification.json",
  "deterministicSmoke": true
}
```

```sh
bun scripts/comparative-benchmark-opencode.ts --config <path-to-config.json>
```

Qualification exercises positive controls and deliberately wrong answers, missing reads, stale revisions, reordered job operations and duplicate submissions. Headless smoke uses isolated OpenCode sessions and a scripted loopback provider. Its result measures whether the host, tools, handoff, and scorer work together. A comparative capability claim requires a separately qualified real-model trial on held-out incidents. The broader V1 claim criteria are in the [capability augmentation plan](v1-capability-augmentation-plan.md).

## Measured Windows result

OpenCode 1.19.5 on Windows passed all six cells on the two development incidents. All 26 scorer controls passed. Every recipient read the correct source before writing, cited the returned manifest and completed without a duplicate submission. For both memory-enabled configurations the harness observed the bound skill in the continuation's system request.

| Configuration | Incidents solved | Recorded arm duration |
| --- | ---: | --- |
| Native Build | 2/2 | 18.8 s and 20.8 s |
| Build with ALG memory | 2/2 | 30.1 s and 31.7 s |
| ALG graph | 2/2 | 35.2 s and 35.5 s |

The identical results qualify the comparison mechanics. The scripted provider follows the procedure in every arm, so these timings describe this smoke run and the scores cannot establish a reasoning advantage. [Windows receipt summary](evidence/factory-handoff-0.5.13/windows.json)
