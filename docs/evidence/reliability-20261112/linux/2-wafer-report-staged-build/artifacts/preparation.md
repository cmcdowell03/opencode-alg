# Wafer evidence report preparation

## Reporting date and sources

- Reporting date: 2025-04-01 UTC.
- Window: inclusive start `2025-04-01T00:00:00Z`; exclusive end `2025-04-02T00:00:00Z`; timezone `UTC`.
- Primary: `SYS-APR-01`, `data/system-export.json` (synthetic system export).
- Supplemental: `MR-APR-01`, `data/manual-review.json` (synthetic manual review sheet).

## Calculation plan

Use the system export for the calculation and count distinct wafer IDs. Its four distinct wafers are W11, W12, W13, and W14. W12 is the only distinct wafer marked defective; its two inspection events count once. The planned numerator is 1, denominator is 4, and rate is 1 / 4 = 0.25. Both sources identify the reporting date but provide no individual event timestamps, so the date-level assignment cannot be independently verified at event level.

## Conflict

W13: system `defect: false`; manual `reviewer_defect: true`. This disagreement is unresolved. Retain the system observation in the reported calculation and disclose both observations in the conflict entry. The manual review agrees with the system on W12.

## Planned report fields

- `numerator`: 1
- `denominator`: 4
- `rate`: 0.25
- `window`: `{"start":"2025-04-01T00:00:00Z","endExclusive":"2025-04-02T00:00:00Z","timezone":"UTC"}`
- `sources`: `["data/system-export.json", "data/manual-review.json"]`
- `conflicts`: `[{"wafer_id":"W13","system_defect":false,"manual_defect":true,"status":"unresolved"}]`
- `limitations`: include the exact sentence "Synthetic analysis only; not process validation." and the event-timestamp scope limitation above; note uncertainty from the unresolved W13 disagreement.

**STOP — preparation only. Create the final report in the subsequent phase.**
