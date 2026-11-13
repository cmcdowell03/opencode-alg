# V1 real-checker and deployment qualification

Candidate: `c23269c4aad0a8aff29f8a397604ad093e3fe7c0` (0.5.11).
Runtime clarification: `1777e44354cf6f817de7882a11472b2adc9b766a`.

**The real-checker admission gate failed. PR #14 remains draft. The planned
eight-pair, sixteen-arm Build/ALG comparison was not issued.** Package readiness
and semantic verification are separate acceptance questions.

## Real-model findings

All diagnostic rounds used `openai/gpt-6-luna` as the fresh checker, with
deterministic local producer/controller roles. There were six issued diagnostic
cases, four of which reached a real checker. Each round was bounded to two cases,
15 minutes per case and 35 minutes total. Expected verdicts stayed outside the
checker context. These are development diagnostics, not an error-rate estimate.

| Round | Commit | Correct action | Defective action |
| --- | --- | --- | --- |
| R1 | `a32d61b` | Inconclusive; exact evidence retrieved | Host version probe failed before checker |
| R2 | `1777e44` | Inconclusive; interpreted “first” as an unbounded claim | Fixture required exit 7 but host recorded 1; stopped before checker |
| V3 | `c23269c` | False rejection / disconfirmed | Correct rejection / disconfirmed |

R1 exposed an underexplained evidence contract plus diagnostic retention and
task-card accounting defects. The journal already validated intent/terminal
linkage; the runtime clarification explains its existing scoped meaning. It
adds no authority for remote effects, exactly-once execution or semantic truth.

R2 exposed diagnostic assumptions. V3 explicitly scopes the criterion to the
first recorded bash call in the producer attempt. The defective command still
requests Node exit 7; V3 requires a reported nonzero exit matching the original
native host tool metadata. Read-only qualification found positive exit 0 and
negative exit 1 in both journal and native database, leaving all 50/37 source
files byte-unchanged. The cause of the differing nested-process/host exit number
was not established. R1/R2 remain failures under their original contracts.

The valid V3 pair lasted 68.341 seconds overall. In the positive case, the
checker acknowledged matching retained command/output in its finding reason but
returned `disconfirmed` and a failing verdict. That is a semantic checker error:
the JSON contract is valid, but the conclusion contradicts its cited observation
and its own explanation. The negative correctly rejected host exit 1.

Both V3 cases established:

- Ten native bash calls, including an initial command exceeding 3 KiB.
- Exact intent and terminal retrieval with two registered page citations.
- One completed parent compaction and one server restart.
- The same journal commitment across four lifecycle boundaries.
- One producer attempt and one checker attempt; no producer replay.
- Correct parent-dispatch accounting, native host/journal consistency, stopped
  owned hosts, removed temporary auth copies and unchanged global configuration.

These findings establish evidence-preservation mechanics for the two cases.
They do not establish reliable semantic verification, autonomous task success,
multi-hour reliability or a causal information-loss rate. A fresh checker’s
mistake after a parent compaction is not proof that compaction caused the mistake.

## Local gates

- At `1777e44`: typecheck; 64 affected Windows tests, zero failures, 537 assertions.
- At `c23269c`: eight diagnostic tests, zero failures, 55 assertions; extracted
  package checks, two passes and 244 assertions; native Windows typecheck.
- At `c23269c` in native WSL Linux: 66 affected tests, zero failures, 547
  assertions, plus typecheck. These are affected tests, not a new full-suite run.
- Eighty HTTP scorer controls passed. The scorer also now requires an observed
  linked cursor chain; complete page coverage alone cannot pass. Recovery/rereads
  remain allowed. Historical benchmark scores were not recomputed.
- A sandboxed typecheck could not read the checkout directory. The native
  typecheck passed; both logs remain recorded. Earlier failures are not relabeled.

These test groups overlap and must not be summed. The earlier full Linux suite
of 1,550 passes belongs to `23fffd8`, not this increment.

## Package acceptance

Both fresh installation and update passed on Windows PowerShell and native WSL
Bash using separately prepared platform bundles of the exact candidate. Their
runtime digest is identical:
`36e4c23c63346d1e580df7ff42ab2032772c8a4f82f2e344f6531e2bbcc56b8c`.
Windows used OpenCode 1.19.5; Linux used 1.18.35. Both used Bun 1.3.14.
These are local acceptance results on one machine and its WSL environment.

All four lanes verified exact source/runtime/package identity, byte-exact
dependency inventories across archive/relocation/installed trees, actual server
and TUI registration, custom configuration and agent preservation, clean
doctor/restart acknowledgement, unchanged isolated configuration snapshots,
owned-process cleanup and an unchanged no-op redeploy. The clean doctor check
does not establish recovery from an injected mid-deployment crash. Package checks
made no model calls. Their fresh host launches are not long-running task tests.

| Measured stage | Windows PowerShell | Native WSL Bash |
| --- | ---: | ---: |
| Stock bundle preparation | 302.56 s | 5.85 s |
| Extracted full-manifest verification | 235.09 s | 0.36 s |
| Fresh 0.5.11 deploy | 708.64 s | 8.64 s |
| 0.5.2 to 0.5.11 update | 579.32 s | 6.07 s |
| Relocation inventory, fresh lane | 261.26 s | 1.14 s |
| Relocation inventory, update lane | 9.13 s | 0.92 s |
| No-op redeploy, fresh lane | 16.93 s | 2.36 s |
| No-op redeploy, update lane | 16.75 s | 2.13 s |

Windows correctness passed, but its deployment latency remains a material
limitation. These individual timings are descriptive, not distributions or a
controlled operating-system comparison. Storage paths, cache state and runtime versions
must be accounted for before attributing the difference.

The verified update baseline is 0.5.2 at
`d62812065e1d3b60cadce35385e1e620cb26f3a0`. Newly created baseline archives derive
from fully verified existing bundles; no original-archive claim is made. Earlier
setup failures remain preserved: Windows long-path checkout, WSL local-clone
ownership, and a test-runner dependency symlink not matched by a directory-only
ignore rule. Fixes were confined to disposable clones and harness setup; no
global Git configuration changed. The frozen candidate was not edited during
acceptance, and the final checkout checks passed.

See [package identities and measured stages](package-acceptance.json) and
[original receipt hashes](package-manifest.json). Later commits in this evidence
directory do not replace the tested candidate or its archive identities.

## Next design decision

The next change should address checker consistency rather than add blind retries
or further tune prompts against this example. For host-verifiable mechanical
claims, define a structured assertion naming the cited observation and required
predicate. Check that assertion against the retained identity, linkage or
reported-exit data. A contradictory assertion is an invalid checker assessment,
eligible only for bounded checker-only repair using the same immutable evidence.
It must never become an automatic pass or cause producer replay. Free-form
reason text must not be adjudicated by keyword matching.

Reuse the existing verification basis, registered page citations, attempt history
and checker-only retry allowance. No new persistence store, general expression
engine or provider-specific branch is needed. Predicate consistency would check
the assessment's internal factual claims; it would not certify that the original
user requirement had been faithfully translated into a predicate.

Before further paid evaluation, qualify contradictory acceptance and rejection,
missing evidence, genuine defects and exhausted checker-only repair locally.
Semantic criteria remain the model’s responsibility; deterministic host facts
are not a substitute for semantic verification. This is a design recommendation,
not implemented behavior or a licensed superiority claim.

The other remaining engineering issue is Windows deployment latency. Inspection
found repeated dependency reads, lockfile hashing and inventory serialization,
but did not establish their contribution to the measured delay. Before changing
the deployment checks, profile enumeration, metadata calls, open/read/close,
hashing and serialization with operation counts, bytes and path depths. Keep
source, staging and installed-release integrity checks intact. Different host
versions, storage paths and environments prevent a causal platform comparison.

All validation was local and V1-only. No GitHub runners, Grok, Gemma, V2 work,
production datalake calls, global configuration changes or merge were performed.
Raw histories and private workspace paths stay private; public summaries and
hashes preserve the measured results and limitations.
