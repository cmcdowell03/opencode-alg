# Turn-routing supplemental review

Run these commands after the terminal native report is available. Keep the two
workflows separate so the reviewer sees only the file required for adjudication.

```powershell
bun packages/v2-preview/benchmark/turn-routing-review.ts packet --run NATIVE_RUN --out packets.json --key review-key.private.json
bun packages/v2-preview/benchmark/turn-routing-review.ts apply --run NATIVE_RUN --key review-key.private.json --packets packets.json --decisions decisions.json --out supplemental-review.json
```

Share only `packets.json` with the reviewer. Keep the run directory and review
key private until adjudication is complete. Packets are ordered by opaque IDs
and contain the common task prompt, source files and parsed submission. The
packets exclude the assignment, advisory supplied during the run, original free
text outside the parsed answer, receipt data, oracle and frozen score. Explicit
runner names in submitted field values are masked while citation positions and
claim IDs are preserved.

## Reviewer instructions

Assess every claim against the supplied sources, including repeated claims.
Use `supported` when the claim is established by its cited rows,
`unsupported` when the citations or evidence are insufficient, and
`contradicted` when the source contradicts it. Cite the exact source rows that
justify the verdict. For a supported claim, use only rows the claim itself cited.
An unsupported claim may have an empty reviewer evidence list.

Set `duplicateOf` to the earlier claim ID if this claim repeats the same finding
for the same consignment. Otherwise use `null`. List the **one-based positions**
of irrelevant, repeated, or invalid citations in `extraneousCitationIndices`.
Give one rationale per claim, covering any flags. If a supported paraphrase
matches a prompted finding code, optionally supply `equivalentTo` with that
code and the consignment ID. Assess the claims independently of their wording
style. Use this JSON format, with one entry for every claim in every packet.

```json
{
  "schema": "turn-routing-review-decisions-v1",
  "decisions": [
    {
      "packetId": "<packet ID from packets.json>",
      "claimId": "c1",
      "verdict": "supported",
      "rationale": "Both rows repeat the same reservation for this consignment.",
      "evidence": ["scanner/reservations.json#scan-1", "scanner/reservations.json#scan-2"],
      "duplicateOf": null,
      "extraneousCitationIndices": []
    }
  ]
}
```

## Supplemental result

The CLI reads a terminal native report and its hashed private receipts. It uses
only the assigned live arms. Historical Willow controls and scripted
qualification are outside this review. Each assigned live arm stays in the
denominator, including early stops, apparatus errors, missing finals and
unparseable submissions.

Apply verifies the exact packet file, requires exactly one decision for each
parsed claim, and replays the original deterministic grade. Only pending claims are sent back through
`gradeDiscovery` with adjudications. A supplemental pass also requires a
completed arm, strict JSON, every claim supported by the reviewer, no duplicate
or extraneous-citation flags, and the original target, disposition,
missing-evidence and verified root-read requirements. The full all-claim
decisions and flags are reported separately. A reviewer may use sources visible
in the packet to contradict a claim. Only the original verified root reads
count toward citation coverage in the grade.

All outputs are new files. The native report and trial receipts remain
read-only. The packet and apply commands run locally without a host, provider
or credentials.

## Native synthesis pairs

Run each command against one terminal run directory. Use a separate directory
and separate decisions for conditional pair B if it runs.

```powershell
bun packages/v2-preview/benchmark/synthesis-pair-review.ts packet --run PAIR_RUN
bun packages/v2-preview/benchmark/synthesis-pair-review.ts apply --run PAIR_RUN --decisions decisions.json
```

Packet writes `PAIR_RUN/review-packets.json` and
`PAIR_RUN/private/review-key.json`. Share only the packet file and the reviewer
instructions above. Ask the reviewer to assess each answer on its own against
the supplied final sources, inspect every citation position for relevance and
validity, and cite the specific rows in each verdict. For these fixtures the
optional equivalent finding codes are `catalog` and `coverage`, with the lot ID
as scope. The reviewer returns the same decisions JSON envelope shown above.
Keep the key, arm mapping, scores, and native artifacts private until the
reviewer has returned decisions. Apply can take explicit `--packets`, `--key`,
and `--out` paths when using files prepared earlier.
For the runner's conditional gate, apply pair A with `--out STUDY/primary-review.json`
where `STUDY` is the runner's study directory and `PAIR_RUN` is
`STUDY/primary-live`.

Apply writes `PAIR_RUN/review-report.json` with schema
`synthesis-pair-supplemental-review-v1`. It records the case ID, report, freeze,
packet and decision hashes, runtime identity result, and counts for assigned,
attempted, missing finals, unreviewable finals, primary passes (`frozenPassed`),
and supplemental passes. Each of the two arm rows includes the outcome, final
presence, packet ID if available, verified root paths, unchanged natural-long
grade and pass flag, supplemental grade and pass flag, and claim decisions
with their unverified citations. A missing answer still occupies its assigned
row. An unattempted assignment has outcome `not-attempted`.

The packet contains the final source versions. In pair B a root receipt for
the superseded version is historical evidence. Citations into the replaced
source require a matching root read of the final digest and its source receipt.
