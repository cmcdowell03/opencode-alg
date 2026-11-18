# Synthetic wafer evidence preparation

## Reporting window and sources

- Reporting date: 2025-04-01.
- Window: start `2025-04-01T00:00:00Z` inclusive; endExclusive `2025-04-02T00:00:00Z` exclusive; timezone `UTC`.
- Primary: `SYS-APR-01`, `data/system-export.json` (synthetic system export).
- Supplemental: `MR-APR-01`, `data/manual-review.json` (synthetic manual review).

Both sources identify the reporting date in UTC; individual rows have no timestamps, so the plan assumes their stated reporting date assigns them to this window.

## Calculation plan

Use the system export for the reported calculation. Count distinct system `wafer_id` values in the window: W11, W12, W13, and W14, for a denominator of 4. Count distinct system-defective wafers: W12, for a numerator of 1. The two W12 inspection events represent the same wafer and do not increase either count. The primary rate is **1/4 = 0.25**.

## Supplemental review and conflict

W12 agrees: system and manual review both identify it as defective. W13 is an unresolved disagreement: `wafer_id` W13, `system_defect` false, `manual_defect` true, `status` unresolved. This disagreement introduces uncertainty about W13; do not merge or overwrite the primary record or change the primary calculation.

## Planned final report fields

- `numerator`, `denominator`, and `rate`.
- `window` with `start`, `endExclusive`, and `timezone`.
- `sources` identifying the primary and supplemental source IDs and paths.
- `conflicts` with `wafer_id`, `system_defect`, `manual_defect`, and `status` for each conflict.
- `limitations`.

Synthetic analysis only; not process validation.

## STOP

STOP after this preparation phase. Do not create `report.json` in this phase.
