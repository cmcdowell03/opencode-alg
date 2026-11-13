# Synthetic wafer evidence report preparation
Reporting date: **2025-04-01**. Reporting window: **[2025-04-01T00:00:00Z, 2025-04-02T00:00:00Z)**, inclusive start and exclusive end. The supplied files identify the reporting date but do not provide event timestamps; the plan relies on that date designation rather than independently filtering events by time.

## Sources

- Primary: `data/system-export.json`, source ID `SYS-APR-01` (synthetic system export).
- Supplemental: `data/manual-review.json`, source ID `MR-APR-01` (synthetic manual review sheet).

## Calculation plan

Use the primary system export for the reported calculation. Count distinct `wafer_id` values, not inspection events: W11, W12, W13 and W14 yield a denominator of **4**. Count distinct system-defective wafers: W12 is the only one, giving a numerator of **1**. Its two defective events, S-202 and S-203, do not add another wafer. The planned rate is **1 / 4 = 25%**.

## Conflict and uncertainty

W13 remains unresolved: system event **S-204** records `defect=false`, whereas the supplemental manual review records `reviewer_defect=true` and the note **"visual mark; confirm against primary record"**. Preserve both observations without merging or overwriting them. The reported calculation remains the primary system result, 1 / 4 = 25%; the disagreement introduces uncertainty about W13's defect status.

## Planned future report fields

- Reporting date and UTC window, including boundary convention.
- Primary and supplemental source IDs and paths.
- Defective-wafer numerator, distinct-wafer denominator, and rate calculation.
- Unresolved conflict with wafer ID, system event and observation, manual observation and note.
- Explicit uncertainty and limitations.

Synthetic analysis only; not process validation.

## STOP

Preparation only. Stop before creating `report.json`; producing the future report is outside this phase.
