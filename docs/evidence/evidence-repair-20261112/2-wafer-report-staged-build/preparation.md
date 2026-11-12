# Wafer evidence report preparation

## Reporting date and window

- Reporting date: 2025-04-01 UTC, as stated by both sources.
- Window: inclusive start `2025-04-01T00:00:00Z`; exclusive end `2025-04-02T00:00:00Z`; timezone `UTC`.
- The source files specify a reporting date but provide no individual event timestamps, so the window relies on the source-level date.

## Sources

- Primary: `data/system-export.json`, source ID `SYS-APR-01` (synthetic system export).
- Supplemental: `data/manual-review.json`, source ID `MR-APR-01` (synthetic manual review sheet).

## Calculation plan

Use the system export as primary. Count distinct system `wafer_id` values for the denominator and distinct wafers with a system defect for the numerator; repeated inspection events do not add wafers. The system has four distinct wafers (W11, W12, W13, W14); W12 is defective in both of its system events and counts once. Thus the planned numerator is 1, denominator is 4, and rate is 1 / 4 = 0.25. Manual review supplements the evidence and does not overwrite the system result.

## Conflict

- W13: system `defect` is `false`; manual `reviewer_defect` is `true`. Status: `unresolved`. The system observation remains primary for the calculation; the disagreement creates uncertainty about W13's defect status.

## Planned report fields

- `numerator`: 1; `denominator`: 4; `rate`: 0.25.
- `window`: `{"start":"2025-04-01T00:00:00Z","endExclusive":"2025-04-02T00:00:00Z","timezone":"UTC"}`.
- `sources`: `data/system-export.json` and `data/manual-review.json`.
- `conflicts`: an entry with `wafer_id` `W13`, `system_defect` `false`, `manual_defect` `true`, and `status` `unresolved`.
- `limitations`: include the exact sentence "Synthetic analysis only; not process validation." Also note the source-level date without individual event timestamps and the unresolved W13 disagreement.

## STOP

Preparation only. Stop here; create `report.json` in the subsequent phase after restart.
