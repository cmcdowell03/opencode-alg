# Wafer evidence report preparation

## Reporting date and window

- Reporting date: 2025-04-01 UTC, as stated in both source files.
- Inclusive start: `2025-04-01T00:00:00Z`.
- Exclusive end: `2025-04-02T00:00:00Z`.
- Timezone: `UTC`. The sources provide a reporting date rather than individual event timestamps; the date is used to associate their records with the window.

## Sources

- `data/system-export.json` — source ID `SYS-APR-01`; primary source for the calculation.
- `data/manual-review.json` — source ID `MR-APR-01`; supplemental manual review.

## Calculation plan

Use distinct wafer IDs from the system export for the denominator: W11, W12, W13, and W14, for a total of 4. Count distinct system-reported defective wafers for the numerator: W12 is defective, and its two inspection events count only once, yielding 1. Calculate the rate as 1 / 4 = 0.25. Retain the system result when manual review disagrees.

## Conflict

- W13: system `defect: false`; manual review `reviewer_defect: true`. Status: `unresolved`. The manual observation introduces uncertainty but does not change the primary-source calculation. W12 agrees across the sources.

## Planned report fields

- `numerator`: 1
- `denominator`: 4
- `rate`: 0.25
- `window`: `{"start":"2025-04-01T00:00:00Z","endExclusive":"2025-04-02T00:00:00Z","timezone":"UTC"}`
- `sources`: `["data/system-export.json", "data/manual-review.json"]`
- `conflicts`: `[{"wafer_id":"W13","system_defect":false,"manual_defect":true,"status":"unresolved"}]`
- `limitations`: include the exact sentence `Synthetic analysis only; not process validation.` and the scope limits that records are synthetic, event timestamps are unavailable, manual review is supplemental, and W13's disagreement remains unresolved.

## STOP

Preparation phase complete. Stop here; create `report.json` only in the subsequent phase after restart.
