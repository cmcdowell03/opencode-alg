# Wafer evidence report — phase 1 preparation

## Reporting date and window

- Reporting date (UTC): 2025-04-01
- Planned window: inclusive `2025-04-01T00:00:00Z`, exclusive `2025-04-02T00:00:00Z` (`timezone: UTC`).

## Supplied sources

- `SYS-APR-01` — `data/system-export.json` (synthetic system export; primary source).
- `MR-APR-01` — `data/manual-review.json` (synthetic manual review; supplemental source).

## Calculation plan

Use the system export as the authority for the reported calculation, with manual review retained as supplemental evidence rather than merged into or substituted for primary observations. Count distinct `wafer_id` values, so repeated inspection events for W12 count once in the denominator. Count primary-source wafers with `defect: true` for the numerator, then calculate `rate = numerator / denominator`. Preserve the UTC inclusive-start/exclusive-end reporting window.

## Known conflict

- Wafer `W13`: system export reports `defect: false`; manual review reports `reviewer_defect: true` (note: “visual mark; confirm against primary record”). This disagreement is unresolved. Planned report entry will expose both observations as `system_defect: false`, `manual_defect: true`, with status `unresolved`; the primary system observation remains controlling for the calculation.

## Planned `report.json` fields

- `numerator` (number): primary-source defective wafer count.
- `denominator` (number): distinct primary-source wafer count.
- `rate` (number): numerator divided by denominator.
- `window`: `{ "start": "2025-04-01T00:00:00Z", "endExclusive": "2025-04-02T00:00:00Z", "timezone": "UTC" }`.
- `sources` (array): `data/system-export.json`, `data/manual-review.json`.
- `conflicts` (array): entries shaped `{ "wafer_id": "W13", "system_defect": false, "manual_defect": true, "status": "unresolved" }`.
- `limitations` (array): include the exact sentence `Synthetic analysis only; not process validation.` and avoid claims of manufacturing readiness or causal impact.

## STOP — phase boundary

This is preparation only. Do not create `report.json` in this phase. Stop here; the report is to be produced only after the planned restart/second phase.
