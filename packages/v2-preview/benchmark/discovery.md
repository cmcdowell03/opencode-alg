# Blinded defect-discovery pilot

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

Run `bun packages/v2-preview/benchmark/discovery-run.ts --help` for the
local qualification and two-step native freeze/execution commands. Keep private
receipts and the arm key apart from the blinded review packets.
