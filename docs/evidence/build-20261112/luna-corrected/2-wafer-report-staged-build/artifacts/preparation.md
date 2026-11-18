# Wafer evidence report — preparation

## Reporting date and window

- Reporting date (from both supplied sources): **2025-04-01** (UTC).
- Planned window: inclusive `2025-04-01T00:00:00Z` through exclusive `2025-04-02T00:00:00Z`.
- Timezone: `UTC`.

## Sources

- `SYS-APR-01` — `data/system-export.json` (primary calculation source).
- `MR-APR-01` — `data/manual-review.json` (supplemental evidence).

## Calculation plan

Use only records for the supplied reporting date/window. Calculate the numerator from the primary system export, counting wafers with `defect: true`; calculate the denominator as distinct `wafer_id` values, not inspection events. The system export has five events for four distinct wafers (W11, W12, W13, W14), and W12's repeated event adds no denominator count. There is one primary-source defect wafer (W12), so the planned rate is `1 / 4 = 0.25` (0.25 as a fraction; 25%). Use the system export as primary and do not merge or overwrite its values with manual review.

## Conflict to disclose

- Wafer `W13`: system observation `defect: false` in `SYS-APR-01`; manual observation `reviewer_defect: true` in `MR-APR-01` (note: “visual mark; confirm against primary record”). This disagreement is **unresolved**. Preserve the primary system observation in the calculation and expose both observations in the report conflict entry.
- W12 agrees across the sources (`true`); it is not a conflict.

## Planned `report.json` fields (next phase)

- `numerator`: number (`1`).
- `denominator`: number (`4`, distinct wafer IDs).
- `rate`: number (`0.25`, numerator divided by denominator).
- `window`: object with `start`, `endExclusive`, and `timezone` (the UTC bounds above).
- `sources`: array of source file paths: `data/system-export.json`, `data/manual-review.json`.
- `conflicts`: array of `{wafer_id, system_defect, manual_defect, status}`; include W13 with `system_defect: false`, `manual_defect: true`, and status marking unresolved.
- `limitations`: array including the exact required sentence: **Synthetic analysis only; not process validation.**

## STOP

Preparation phase only. Do not create `report.json` in this phase. Stop here; the report is to be produced only after the run is restarted.
