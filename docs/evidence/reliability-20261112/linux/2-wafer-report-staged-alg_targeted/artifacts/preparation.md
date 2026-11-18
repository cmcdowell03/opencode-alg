# Synthetic wafer report preparation
## Reporting date and sources

- Reporting date: **2025-04-01**. Planned UTC window: inclusive start `2025-04-01T00:00:00Z`, exclusive end `2025-04-02T00:00:00Z`.
- Primary system export: `SYS-APR-01`, `data/system-export.json`.
- Supplemental manual review: `MR-APR-01`, `data/manual-review.json`.

## Calculation plan

Use the system export as the primary source. Count distinct `wafer_id` values in the reporting window for the denominator, and distinct system-defective wafers for the numerator, so repeated inspection events do not add wafers or duplicate defects. The system records cover W11, W12, W13 and W14; W12 is recorded defective twice but counts once. The planned calculation is **1 defective wafer / 4 distinct wafers = 0.25 (25%)**. Event-level timestamps are not supplied; window membership is inferred from the sources' UTC reporting date rather than verified for each event.

## Conflict and uncertainty

W13 is an **unresolved** disagreement: system event `S-204` records `defect=false`, while manual review records `reviewer_defect=true`, with the note “visual mark; confirm against primary record”. Preserve both observations in the report, but retain the system observation in the calculation. The disagreement creates uncertainty and is not resolved by source precedence.

## Planned report fields

- `numerator`: number of distinct system-defective wafers, planned as `1`.
- `denominator`: number of distinct system wafers, planned as `4`.
- `rate`: numerator divided by denominator, planned as `0.25`.
- `window`: object with `start`, `endExclusive`, and `timezone` set to the UTC window above.
- `sources`: array containing `data/system-export.json` and `data/manual-review.json`.
- `conflicts`: array containing W13 with `wafer_id`, `system_defect: false`, `manual_defect: true`, and `status: unresolved`.
- `limitations`: array including the unresolved disagreement, the source-date limitation, and the exact sentence: **Synthetic analysis only; not process validation.**

## STOP

**STOP: Preparation phase only. Do not create `report.json` until the later phase after restart.**
