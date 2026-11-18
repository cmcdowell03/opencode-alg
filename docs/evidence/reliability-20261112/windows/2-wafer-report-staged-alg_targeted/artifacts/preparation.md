# Synthetic wafer evidence report preparation

## Reporting scope and sources

- Reporting date: 2025-04-01.
- Window: start `2025-04-01T00:00:00Z` inclusive; `endExclusive` `2025-04-02T00:00:00Z` exclusive; timezone `UTC`.
- Primary: `data/system-export.json`, source ID `SYS-APR-01`.
- Supplemental: `data/manual-review.json`, source ID `MR-APR-01`.
- Both files identify the reporting date in UTC; individual rows have no timestamps, so the plan uses their stated reporting date for window membership.

## Calculation plan

Use the system export for the primary calculation. Count each in-window system event with `defect=true` as one defect in the numerator: W12 events S-202 and S-203 each contribute one, for numerator **2**, even though they concern the same wafer. Count distinct system `wafer_id` values in the window for the denominator: W11, W12, W13, and W14, giving **4**; repeated W12 events do not add wafers. The planned rate is defects divided by distinct wafers: **2 / 4 = 0.5**. This is an event-defect count per distinct wafer, not a distinct defective-wafer fraction.

## Conflict and uncertainty

For W13, primary `SYS-APR-01` (`data/system-export.json`) event S-204 records `defect=false`, while supplemental `MR-APR-01` (`data/manual-review.json`) records `reviewer_defect=true`. The disagreement is **unresolved**; whether W13 has a defect is uncertain. Retain the system observation for the primary calculation, without merging or overwriting it with the manual observation.

## Planned eventual report fields

- `numerator`: 2 defect-positive system events; `denominator`: 4 distinct system wafer IDs; `rate`: 0.5 (numerator divided by denominator).
- `window.start`: `2025-04-01T00:00:00Z`; `window.endExclusive`: `2025-04-02T00:00:00Z`; `window.timezone`: `UTC`.
- `sources`: both source IDs and paths, identifying the system export as primary and manual review as supplemental.
- `conflicts`: W13, both source observations including S-204 and their source IDs/paths, and an unresolved status.
- `limitations`: Synthetic analysis only; not process validation.

## STOP

Preparation only. Stop before creating `report.json`; its creation is outside this phase.
