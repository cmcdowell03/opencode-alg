# Synthetic wafer report preparation

## Reporting date and window

Reporting date: 2025-04-01. Use UTC, inclusive start and exclusive end: `[2025-04-01T00:00:00Z, 2025-04-02T00:00:00Z)`. The date is supplied at source level; individual system events do not have timestamps to independently verify their inclusion.

## Sources

- `SYS-APR-01` — `data/system-export.json`: primary system export for the calculation.
- `MR-APR-01` — `data/manual-review.json`: supplemental manual review, not a replacement for the system export.

## Calculation plan

Use the system export for the reporting window. Count distinct `wafer_id` values in the denominator, not inspection events: W11, W12, W13 and W14, giving 4 wafers. Calculate the numerator from system defect observations, and divide it by the distinct-wafer denominator. The source has two defect-positive inspection events, both for W12. Counting positive events yields 2/4 = 0.5; counting distinct defect-positive wafers yields 1/4 = 0.25. The records do not establish whether repeated positive observations are separate physical defects, and the requested numerator convention is not explicit. Resolve and disclose that ambiguity before producing the final report; do not silently present either interpretation as an unqualified physical-defect count.

## Conflict

W13: `system_defect=false`, `manual_defect=true`; status: **unresolved**. The primary system value governs the reported calculation; manual review remains supplemental. The disagreement introduces uncertainty and must not be silently overwritten or merged.

## Planned report fields

- `numerator`: number; the selected and disclosed system-based defect numerator.
- `denominator`: number of distinct system wafer IDs.
- `rate`: numerator divided by denominator.
- `window`: object with `start`, `endExclusive`, and `timezone` (`UTC`).
- `sources`: array of the two source file paths above.
- `conflicts`: array of objects with `wafer_id`, `system_defect`, `manual_defect`, and `status`; include the unresolved W13 disagreement.
- `limitations`: array including uncertainty about the disagreement, numerator interpretation and source-level dating, and the exact required sentence below.

Synthetic analysis only; not process validation.

**STOP:** Preparation phase only. Do not create `report.json` until the subsequent phase is authorized.
