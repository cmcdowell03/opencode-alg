# Synthetic wafer evidence: phase-one preparation

## Reporting scope and sources

Both supplied sources identify the reporting date as **2025-04-01** UTC. The reporting window is **2025-04-01T00:00:00Z inclusive through 2025-04-02T00:00:00Z exclusive**. The fixture has a reporting date but no individual event timestamps, so the window is based on the source-level date.

- Primary: `data/system-export.json`, source ID `SYS-APR-01`.
- Supplemental: `data/manual-review.json`, source ID `MR-APR-01`.

## Calculation plan

Use the system export for the reported calculation. Count distinct `wafer_id` values as the denominator and distinct wafers with a system `defect=true` observation as the numerator. The primary rows contain W11, W12, W13 and W14: denominator **4**. W12 has two events, S-202 and S-203, but counts once; it is the only distinct wafer marked defective by the system, giving numerator **1**. The primary rate calculation is **1/4 = 25%**.

## Unresolved conflict

For W13, system event S-204 says `defect=false`; supplemental manual review says `reviewer_defect=true` and notes "visual mark; confirm against primary record". This disagreement remains unresolved and makes the classification uncertain. Preserve the primary system result; do not overwrite or silently merge the observations. The manual review of W12 matches the system.

## Planned report fields

- Reporting date and inclusive-start, exclusive-end UTC window.
- Source IDs, paths and primary/supplemental roles.
- Primary numerator, distinct-wafer denominator, rate and calculation.
- Conflict disclosure with both observations and uncertainty.
- Limitations.

Synthetic analysis only; not process validation.

**STOP before report.json.** Phase one is preparation only; do not create the final report in this phase.
