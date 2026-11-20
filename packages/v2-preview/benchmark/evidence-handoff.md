# Installed evidence handoff benchmark

Use Bun 1.3.14, Git, the native OpenCode 2.3.2 executable and a fresh staged
preview bundle. Run from the repository root. On Windows the existing isolated
host fixture is `../v2-isolated-hosts/node_modules/@opencode/cli-windows-x64/bin/opencode.exe`.
The process needs writable OS temp and loopback access for the host, provider
fixture, MCP workbench and factory. Each arm gets a separate project and
OpenCode database. The independent checker can read the audit endpoint and the
owner can read the inspection endpoint.

```powershell
$opencodeHostPath = '../v2-isolated-hosts/node_modules/@opencode/cli-windows-x64/bin/opencode.exe'
$evidenceBundle = '../v2-isolated-hosts/evidence-handoff-bundle'
bun packages/v2-preview/build.ts $evidenceBundle
bun packages/v2-preview/benchmark/evidence-handoff.ts --host $opencodeHostPath --package $evidenceBundle --out ../v2-isolated-hosts/evidence-held-out.json
bun packages/v2-preview/benchmark/evidence-handoff.ts --host $opencodeHostPath --package $evidenceBundle --out ../v2-isolated-hosts/evidence-exhausted.json --case exhausted
bun packages/v2-preview/benchmark/evidence-handoff.ts --host $opencodeHostPath --package $evidenceBundle --out ../v2-isolated-hosts/evidence-changed.json --case changed
```

The local scripted provider uses the pages and audit it receives. The frozen
grader uses a separate answer key. Each root reads the first prefix, stops
with incomplete evidence, completes a native manual compaction, and resumes
from the same persisted session after a new host process starts. Both arms get
the same prompts, approved skill, workbench data, and query budget. The changed
case alters an overlapping row at the second limit. The exhausted case ends
before any prefix qualifies. Successful resolution requires a separate checker
read. ALG also settles one read-only manifest and acknowledges the action and
prerequisite before status can certify the decision. Its manifest bookkeeping is
counted separately from the shared inspection and audit reads.

For a separately authorized live pair, use a new output pathname and add
`--native-model openai/<id> --allow-model-calls --auth-file <oauth-auth.json>`
to the held-out command. Both arms use the supplied model ID and the existing
native OpenAI OAuth observer. The auth file must contain a current access
credential with more than 15 minutes remaining. Use `--order alg-first` to
reverse the arms. The launcher reserves the receipt path before starting the
host and fails if that path already exists.

The receipt includes fixture, skill, prompt, oracle and grader digests. It
records actual manual summary and restart lineage, scoped native tool calls,
provider-visible progress roles, status and acknowledgement results, and
workbench admissions. Session and cache evidence is captured while each host is
still running. Provider input tokens come from live usage. Cached input is
available only when complete host session totals match the provider totals, and
uncached input is computed from those matched counts. Scripted runs report
request bytes and leave provider and cache token measurements null.
