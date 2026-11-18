# Wafer evidence report preparation

## Reporting date and window

- Reporting date: 2025-04-01 (UTC).
- Inclusive start: `2025-04-01T00:00:00Z`.
- Exclusive end: `2025-04-02T00:00:00Z`.
- Both source files identify this reporting date; their individual rows have no event timestamps.

## Sources

- `SYS-APR-01`: `data/system-export.json` — primary system export.
- `MR-APR-01`: `data/manual-review.json` — supplemental manual review.

## Calculation plan

Use the system export for the reported calculation. Count distinct system `wafer_id` values for the denominator: W11, W12, W13, and W14, giving 4. Count distinct system wafers marked defective for the numerator: W12, giving 1; its two inspection events do not count twice. Calculate the rate as 1 / 4 = 0.25. Compare manual observations with system observations and disclose disagreements without overwriting the primary result.

## Conflict

- W13: system `defect` is `false`; manual `reviewer_defect` is `true`. Status: unresolved. The disagreement creates uncertainty about W13's defect status; the reported calculation retains the system observation.

## Planned report fields

- `numerator`: 1
- `denominator`: 4
- `rate`: 0.25
- `window`: `{ "start": "2025-04-01T00:00:00Z", "endExclusive": "2025-04-02T00:00:00Z", "timezone": "UTC" }`
- `sources`: `["data/system-export.json", "data/manual-review.json"]`
- `conflicts`: `[{ "wafer_id": "W13", "system_defect": false, "manual_defect": true, "status": "unresolved" }]`
- `limitations`: include the exact sentence `Synthetic analysis only; not process validation.` and note that the sources have date-level reporting labels but no individual event timestamps, and that the W13 disagreement remains unresolved.

## STOP

Preparation only. Stop here; create `report.json` in the subsequent phase after restart.
