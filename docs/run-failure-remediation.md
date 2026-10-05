# Worker output failure remediation

This change addresses the output parsing and deployment uncertainty described in an operator's October 2026 air-gapped deployment report. It preserves strict output schemas, filesystem containment, permission checks, and checker and shell gates. The design is independent of model or provider.

## Evidence and limits

The supplied report describes 73 runs, 53 terminal failures, and 156 failed attempts, including 117 JSON parsing failures. These are operator-reported figures, not an independently reproduced dataset. Attempt counts cannot establish the fraction of failed runs a parser change will recover: one run can fail repeatedly or encounter another failure after parsing succeeds.

At the review baseline, `b5ec63b`, `src/sessions.ts` accepted a bare JSON object or one whole-response Markdown fence. The tests explicitly rejected prose-wrapped JSON. This directly supports the reported parsing mechanism. The described local extraction patch was not present in that baseline. Root `$schema` removal was already implemented upstream; this change preserves that narrow exception rather than accepting arbitrary extra fields.

Four reported successful runs after restart are encouraging but do not establish a sustained success rate. Source modified on disk does not prove that a running host loaded it. The explanation that later failures came from an old process is plausible, but cannot be verified retrospectively without process or build evidence. New deployment diagnostics make future comparisons possible without exporting private run data.

## Response handling contract

Valid formatting variation is not a quality failure. A worker can return one complete JSON object surrounded by prose or Markdown. Extraction must respect string escapes and nesting, operate within fixed size and candidate limits, and reject malformed or truncated candidates rather than repair their content.

Ambiguous output is different from formatting variation. Do not blindly select the first object or first fence. A standalone extractor rejects competing objects. Where the worker role is known, schema-based selection may accept exactly one valid role output; multiple valid outputs still fail. An object nested inside an array or malformed parent must not be salvaged as an independent answer.

For fresh implementer responses only, backslashes in path fields can be converted to forward slashes before existing validation. This does not authorize converting absolute paths to relative paths, collapsing traversal segments, replacing another run's identifier, coercing field types, or relaxing persisted schemas. Artifact paths remain confined to the current run. Filesystem containment checks still reject symlink escapes.

Worker prompts must state the actual run identifier, project-relative path syntax, and current artifact directory. An optional artifact path should be omitted if no artifact was produced. Prompt guidance complements validation; it never replaces it.

Diagnostics should expose stable structural facts, not raw output: parsing category, known schema field, issue code, and bounded allowlisted completion metadata. Redacted diagnostics are not evidence that a worker disclosed credentials. An empty text result alone does not prove step exhaustion; tool-only output and provider or SDK failures remain possible.

## Offline deployment contract

Use the [air-gapped deployment guide](air-gapped-deployment.md) for package preparation, configuration, offline checks, restart, and rollback. A ZIP checkout is not a self-contained installation unless its matching runtime dependencies are also available.

String plugin registration plus a validated package-local or explicitly selected sidecar provides an option channel when the host cannot load tuple registration. The reported tuple crash has not been reproduced against the operator's host, so this is a compatibility workaround, not a claimed upstream host fix. Local configuration must not be committed or included in a redistributed package.

A captured startup source digest and a current disk digest serve different purposes. A difference means the process needs a restart to use the disk version. Equality is useful operational evidence, not cryptographic proof of every byte executed by the host. An offline diagnostic command checks files in the extraction directory; it cannot inspect or certify a separate OpenCode process.

## Boundaries and acceptance criteria

The change must be verified with synthetic fixtures and no model calls, production credentials, database access, or network dependence. Required checks cover:

- Prose, fences, escaped strings, nested objects, ambiguity, arrays, truncation, and input bounds.
- Valid Windows separator conversion together with rejection of absolute, traversal, cross-run, and filesystem escape paths.
- Current-run prompt guidance and safe schema and empty-response diagnostics.
- Strict sidecar validation, deterministic precedence, ambiguous or invalid configuration, and a ZIP-like installation without Git metadata.
- Startup versus disk identity and offline diagnostic behavior without changing user state.
- Existing permission, schema, shell, executor, packaging, and type-checking regressions.

Do not raise all worker step limits or retry budgets as a substitute for identifying the failure. Do not accept a missing output, bypass a failed gate, or retry a worker's mutations indefinitely. Schema feedback can help a subsequent attempt, but safe parsing should resolve formatting differences without another model call.

Shell gates already canonicalize and confine their working directory. A nonzero exit can still mean a missing dependency, incorrect command path, setup failure, or failing test. It is not automatically a legitimate code-quality rejection, nor should ALG invent a replacement command. SDK errors can be diagnosed more safely with bounded metadata, but their underlying provider cause cannot be established from an empty safe diagnostic alone.

These fixes do not claim to eliminate 75 percent of failed runs, prove long-duration reliability, repair external SDKs, or install the update on the air-gapped host. Subsequent local observations should separate attempts from terminal runs and group them by the runtime identity actually reported by the host.
