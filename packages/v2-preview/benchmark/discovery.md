# Blinded defect-discovery pilot

## Measured read-only comparison

All six predeclared Luna trials completed on OpenCode 2.3.2 with preview.9.
Both ALG sessions recorded their findings and explicit disposition, read the
same revision back, and exported a matching file. Neither submitted an external
job. All six assistants returned the requested JSON shape. There were zero
duplicate source reads within a role. The focused arms used the same
harness-scheduled independent child. The native `/alg-review` command has
separate installed-host coverage.

| Condition | Complete task passes | Fully supported closures on Pine | Correctly supported abstentions on Elm | Model requests | Total provider tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Stock Build | 0/2 | 0/1 | 0/1 | 6 | 12,128 |
| Build with focused checker | 1/2 | 0/1 | 1/1 | 16 | 42,108 |
| ALG with focused checker | 0/2 | 0/1 | 0/1 | 42 | 655,170 |

On Pine, ALG identified the repeated reservation and the separate picking
shortage on the first consignment. It attributed the other discrepancy to
carrier tare, then called a one-unit discrepancy two units and closed the
incident. All three arms fell short of full closure. The frozen rubric maps a
compound claim to at most one target and requires row citations. Its recall
score can therefore omit an explanation the assistant actually wrote.

On Elm, all three assistants identified the missing signed tally and withheld
closure. Independent review supported both ALG claims. Its final answer added
a citation to the entire procedure file, which the owner had read but which
did not meet the requested row-citation format. Stock Build omitted required
rows. Only Build with the focused checker met every requirement.
ALG's saved follow-up asked for the signed tally. A diagnostic requiring
the finding's missing-evidence text to equal its bare path missed that
match because the finding described the tally in a sentence.

ALG used about 15.6 times the total provider tokens of the matched checker
control. These totals include cached input. Both ALG sessions read eight
sources per role; some repeated ledger status responses exceeded 23,000
characters. These observations support testing compact acknowledgements and
on-demand citation detail. Source provenance alone cannot check a numerical
magnitude. Two incidents support a deployment finding and a diagnostic
comparison. They give no reliable estimate of an overall accuracy advantage.
[Frozen protocol](../evidence/read-only-discovery-luna-freeze.json) ·
[Answers, blinded decisions and usage](../evidence/read-only-discovery-luna.json)

Elm also exposed an export defect. The owner recorded one missing path and
the exporter appended the finding's prose explanation as a second entry.
Preview.10 preserves the owner-recorded list verbatim. The measured results
above describe preview.9.

## Focused read-only pilot

Select `--variant focused-read-only` for the new two-incident pilot. Pine
contains coexisting defects on one consignment. Elm has an unavailable record
that prevents closure and a separate diagnosable defect. Both incidents run
once in each of three assigned conditions: Build, Build with a focused ordinary
checker, and read-only ALG with the same focused ordinary checker. The freeze
preselects both incidents and their arm order.

Both checkers get the same question from a public triage record, the same case,
and the same source catalog, permissions, model, and read cap. Each starts in a
fresh child without the owner's answer. Root sessions share the same source
catalog and root read cap. All arms share the same model and aggregate
48-request and 20-minute limits. Both reviewed arms have the same 48-call
MCP source allowance for the checker, alongside the same 48-call allowance for
the root. Build alone has one root turn. Both reviewed arms have the same
initial, checker, and revision turn structure. The ALG-only instructions explain
how to use the installed controls. The harness supplies the common checker
question and records any separate evidence-linked question the ALG owner wrote.

The scored output is the root assistant's actual final message. The first
outcome dimension is strict JSON format on that raw text. The text grader can
recover one unambiguous report object from fenced or wrapped text for semantic
and citation scoring. Raw text without a recoverable report is counted as
unscored content and appears in the format and assigned-arm results. A blind
reviewer evaluates every recovered claim from the anonymous packet, including
known categories. The frozen grade then reports separately:

- Supported defect recall among content-scored answers, omitted and
  unsubstantiated defects, and findings missing required row citations.
- Citations backed by completed root `sources_discovery_read` results
  matched to the source server receipt and contents. Checker reads have
  their own namespace and receipts.
- Correct disposition, exact unavailable evidence, complete incident closure,
  supported abstention, and unsupported closure. The combined task pass also
  requires strict format and verified citations.
- For ALG, acknowledged finding writes, exact finding and closure readback at
  the same decision revision, and a current `owner_recorded` report at the
  same evidence revision. This operational receipt defines verified ledger
  uptake. The canonical report's disposition, missing evidence, and
  citation coverage, and the unresolved-evidence question are scored
  separately. The native `/alg-report` export is captured after the final
  answer when eligible and checked for matching bytes and zero added model
  requests or source calls. The exported report has its own receipt.

Report all issued arms by assignment, including budget exhaustion, apparatus
failure, and unusable answers. The verified-ledger subset is descriptive.
Treat the incident as the paired unit and publish the two paired results as a
pilot. Loopback answers are scripted to exercise the receipts and grader.

### Local qualification and native freeze

Run from the shared checkout. Use the same explicit `$hostPath` and
`$stagedPackage` for local qualification, freeze, and authorized execution.
Choose fresh destinations whose parent directories already exist.

```powershell
bun --no-install packages/v2-preview/build.ts $stagedPackage
bun test packages/v2-preview/benchmark/discovery-focused.test.ts packages/v2-preview/benchmark/discovery-native.test.ts packages/v2-preview/tests/discovery-cases.test.ts packages/v2-preview/tests/discovery-grade.test.ts packages/v2-preview/tests/discovery-finalize.test.ts
bun --no-install packages/v2-preview/benchmark/discovery-run.ts --variant focused-read-only --case all --host $hostPath --package $stagedPackage --out $localReceipts
```

After local acceptance, freeze the exact staged host and package. The freeze
pins source hashes, both cases and their oracles, arm order, both checker
prompts, the revision and ALG prompts, and the budgets. Execute only the
approved freeze. Keep its private receipts and key separate from the blind
packets, and have the independent reviewer return decisions before unblinding.

```powershell
bun --no-install packages/v2-preview/benchmark/discovery-run.ts --variant focused-read-only --case all --host $hostPath --package $stagedPackage --native-model openai/gpt-6-luna --freeze $freeze
# The next command makes paid model calls. Run only after approval.
bun --no-install packages/v2-preview/benchmark/discovery-run.ts --variant focused-read-only --case all --host $hostPath --package $stagedPackage --native-model openai/gpt-6-luna --frozen $freeze --allow-model-calls --out $nativeReceipts
bun --no-install packages/v2-preview/benchmark/discovery-finalize.ts --review-guide-focused
bun --no-install packages/v2-preview/benchmark/discovery-finalize.ts --private "$nativeReceipts/private" --blinded "$nativeReceipts/blinded" --frozen $freeze --decisions $blindDecisions --output $adjudicatedReport
```

## Historical five-arm pilot

The primary question is whether ALG helps an investigator find *every* material
defect and cite the records that establish it. A second question is whether
asking an independent reviewer to seek counterevidence adds value over an
ordinary independent review. Both questions also require measuring false
attribution, unjustified closure and correct abstention.

Five synthetic incidents have the same opening symptom and reporting contract.
Each session gets a fresh host database, the same public evidence for its
incident, and a bounded read interface. The answer key is derived from source
rows outside every agent workspace. A grader checks cited rows against the
actual read ledger. Previously unrecognized claims go to a reviewer who sees
the public sources and an anonymized submission. Review decisions are recorded
separately from the original machine grade.

The conditions are stock Build, Build with ordinary review, Build with
adversarial review, ALG with ordinary review, and ALG with adversarial review.
The two matched Build controls separate the benefit of an extra reader from the
benefit of ALG. Each reviewed arm gives the child the problem without the
owner's draft, and gives the owner an opportunity to revise after receiving
the review. Receipts record whether the plugin was available, used, and
actually produced an acknowledged ledger write followed by a matching read.
Include every attempted arm in the deployment comparison. Report the subgroup
with verified ledger use separately.

## First live measurement

Before any paid calls, qualify the host and read permissions with loopback
sessions, then freeze the runtime, fixtures, grader, prompts, order and limits.
Select case 4 before looking at any model results. Its multiple concurrent
causes make a plausible partial explanation particularly costly. Run each of
the five arms once on Luna. Separately repeat one held-out Build/ALG handoff
pair on the same model with child verification enabled and its original answer
key. Do not retry a valid losing arm. Preserve interrupted attempts and
distinguish host failures from wrong or missing answers.

Each arm has a 48-request ceiling. Measure severity-weighted outcomes through
the explicit severe-miss and unsupported-certification counts, alongside
material recall, complete incident closure, correct abstention, verified source
reads, time and actual token use. The first live case is a pilot. A superiority
claim requires fresh held-out incidents, repeated paired runs and uncertainty
estimates on the **incident** as the sampling unit. Multiple claims about one
lot do not create independent trials.

## Measured pilot

The independent review accepted both attributions for stock Build, Build with
adversarial review, and ALG with ordinary review. The table counts supported
cause-and-lot attributions as judged from the claims and their own citations.
The frozen closure grade separately requires all specified row references.

| Condition | Supported causes out of 2 | Complete closures out of 1 | Model requests |
| --- | ---: | ---: | ---: |
| Build | 2 | 0 | 3 |
| Build with ordinary review | 1 | 0 | 9 |
| Build with adversarial review | 2 | 0 | 8 |
| ALG with ordinary review | 2 | 0 | 16 |
| ALG with adversarial review | 1 | 0 | 15 |

Eight supported attributions across the five answers lacked the full frozen
citation set. The adversarial ALG answer incorrectly treated the clock evidence
as inconclusive. Both ALG sessions created a ledger, attempted a rejected
submission, then read decision revision zero. Neither supplied an acknowledged
write and matching readback. This pilot measures installed behavior and gives
no estimate of the effect of successful ledger use. [Submissions, blind decisions and usage](../evidence/discovery-pilot-luna.json)

On the separate restart pair, Luna certified ALG's decision before the explicit
relay. Both arms found five defects and two verified corrections. Both missed
the exact response contract after resume, and ALG answered the final relay in
prose. The first pair was interrupted by an observer that blocked compaction.
The corrected pair used the original task, grader and budget. [Pair and intercepted attempt](../evidence/child-audit-luna-2.3.2.json)

Run `bun packages/v2-preview/benchmark/discovery-run.ts --help` for the
local qualification and two-step native freeze/execution commands. Keep private
receipts and the arm key apart from the blinded review packets.

Use `discovery-finalize.ts --review-guide` for reviewer instructions and
`--help` for the finalization command. Keep the original independent freeze
and run receipts. The historical Luna benchmark was frozen at `4b1d378` and
adjudicated with the finalizer at `dedcab5`. Use those revisions for historical
reproduction. The finalizer verifies
the source hashes, original read ledger, answers, anonymous packets, and
review decisions before writing a separate results file.
