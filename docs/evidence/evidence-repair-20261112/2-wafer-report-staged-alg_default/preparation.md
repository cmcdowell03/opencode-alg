# Synthetic wafer evidence report preparation

Reporting date: 2025-04-01 (UTC).

## Sources and precedence

- Primary: synthetic system export, source ID `SYS-APR-01`, `data/system-export.json`.
- Supplemental: synthetic manual review sheet, source ID `MR-APR-01`, `data/manual-review.json`.
- Apply the supplied `wafer-analysis` skill. Preserve the system result when the sources disagree; do not merge or overwrite observations.

## Calculation plan

Use the UTC window [2025-04-01T00:00:00Z, 2025-04-02T00:00:00Z), inclusive start and exclusive end. Both files identify the reporting date, but their rows have no individual timestamps, so individual event membership in the window cannot be independently verified; use the supplied reporting-date designation and disclose this limitation.

In the primary export, count defect-positive event rows: S-202 and S-203, numerator 2. Count distinct system `wafer_id` values: W11, W12, W13 and W14, denominator 4; the two W12 events do not add another wafer. The planned rate is 2 / 4 = 0.5 defects per distinct wafer. This event-based rate is not a defective-wafer fraction.

## Unresolved conflict and uncertainty

For W13, system event S-204 records `defect=false`, while the manual review records `reviewer_defect=true` and notes a visual mark to confirm against the primary record. This disagreement remains unresolved; it creates uncertainty about W13's observation. Keep the system export primary and do not change the planned numerator based on the supplemental review.

## Planned later report content

Include the reporting date and UTC window with boundary semantics; source IDs and paths and their precedence; the defect-positive event numerator; distinct-wafer denominator; calculation and units; the W13 observations, unresolved conflict and associated uncertainty; the absence of row-level timestamps; and this exact limitation:

Synthetic analysis only; not process validation.

The authoritative required report schema has not been located in the supplied workspace. Its field names and structure remain unresolved; obtain the authoritative schema before producing the later report. The content list above is a plan, not an authoritative schema.

## STOP

STOP for compaction and restart. This phase is preparation only; do not create `report.json` in this phase.
