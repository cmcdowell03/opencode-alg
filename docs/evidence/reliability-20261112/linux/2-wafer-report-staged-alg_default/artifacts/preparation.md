# Synthetic wafer evidence report preparation

## Reporting window and sources

- Reporting date: 2025-04-01 (UTC).
- Window: start `2025-04-01T00:00:00Z` inclusive; endExclusive `2025-04-02T00:00:00Z` exclusive; timezone `UTC`.
- Primary: `SYS-APR-01`, `data/system-export.json` (synthetic system export).
- Supplemental: `MR-APR-01`, `data/manual-review.json` (synthetic manual review).

Both sources identify the reporting date; their rows contain no individual timestamps, so the date-level designation is the available window evidence.

## Calculation plan

Use the system export as the primary source. Count distinct `wafer_id` values, not inspection events: W11, W12, W13 and W14 give a denominator of 4. W12 is the sole system-defective wafer; its two positive events S-202 and S-203 count once, giving a numerator of 1. Calculate defects divided by distinct wafers: rate = 1 / 4 = 0.25.

## Conflict and uncertainty

For W13, the system reports `system_defect: false` while manual review reports `manual_defect: true`. Status: `unresolved`. The supplemental observation does not overwrite or merge into the primary system calculation; the disagreement remains an uncertainty. W12 is positive in both sources.

## Planned report.json fields

- `numerator`: number, 1.
- `denominator`: number, 4.
- `rate`: number, 0.25.
- `window`: object with `start` (`2025-04-01T00:00:00Z`), `endExclusive` (`2025-04-02T00:00:00Z`) and `timezone` (`UTC`).
- `sources`: array of source file paths: `data/system-export.json` and `data/manual-review.json`.
- `conflicts`: array of objects with `wafer_id`, `system_defect`, `manual_defect` and `status`; the W13 object has values `W13`, `false`, `true` and `unresolved`, respectively.
- `limitations`: array of scope-limit strings, including the exact sentence below and the unresolved disagreement. These synthetic records do not establish manufacturing readiness or causal impact.

Synthetic analysis only; not process validation.

## STOP

Preparation only: do not create `report.json` in this phase. Stop before producing the final report; the run will be compacted and restarted.
