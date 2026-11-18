# Wafer evidence report preparation

## Reporting date and window

- Reporting date: 2025-04-01 (UTC), as stated by both sources.
- Inclusive start: `2025-04-01T00:00:00Z`.
- Exclusive end: `2025-04-02T00:00:00Z`.
- Timezone: `UTC`.

## Sources

- `data/system-export.json` — `SYS-APR-01`, synthetic system export; primary for the calculation.
- `data/manual-review.json` — `MR-APR-01`, synthetic manual review sheet; supplemental evidence.

## Calculation plan

Use the system export for the reporting date. Count distinct `wafer_id` values for the denominator, and count distinct wafers with a system `defect: true` for the numerator. Do not count repeated inspection events as additional wafers or defects. The system records contain W11, W12, W13, and W14: denominator 4. W12 is the only system-defective wafer, despite two matching events: numerator 1. The planned rate is 1 / 4 = 0.25.

## Conflict

W13 has `system_defect: false` (system event S-204) and `manual_defect: true` (manual review). The disagreement is unresolved and creates uncertainty. Preserve the primary system value in the calculation and disclose both observations in the report. W12 agrees across sources.

## Planned report fields

- `numerator`: 1; `denominator`: 4; `rate`: 0.25.
- `window`: `start`, `endExclusive`, and `timezone` using the UTC values above.
- `sources`: both source file paths above.
- `conflicts`: an entry for W13 with `wafer_id`, `system_defect`, `manual_defect`, and `status: "unresolved"`.
- `limitations`: include the exact sentence: "Synthetic analysis only; not process validation." Also state that the manual/system disagreement remains unresolved and the calculation follows the system export.

## STOP

Preparation is complete. Stop here; create `report.json` only in the subsequent phase after restart.
