export type IncidentFamily = "chamber" | "material" | "inspection-artifact" | "insufficient-evidence"

export interface SyntheticCatalogEntry {
  catalog_id: string
  incident_family: IncidentFamily
  source_ref: string
  source_version: string
  scope: string
  event_time: string
  cohort: string
  evidence: string
  coverage: "complete" | "partial" | "missing"
  uncertainty: string[]
}

const families: readonly IncidentFamily[] = [
  "chamber", "material", "inspection-artifact", "insufficient-evidence",
]

/** Deterministic local catalog; rows are fixtures, not claims about a real process. */
export function syntheticInvestigationCatalog(size = 11_000): SyntheticCatalogEntry[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("catalog size must be a positive integer")
  return Array.from({ length: size }, (_, index) => {
    const family = families[index % families.length]!
    const sequence = String(index).padStart(5, "0")
    const incomplete = family === "insufficient-evidence"
    return {
      catalog_id: `catalog-${sequence}`,
      incident_family: family,
      source_ref: `synthetic://${family}/${sequence}`,
      source_version: `fixture-${1 + (index % 3)}`,
      scope: Math.floor(index / 4) % 2 === 0 ? "line-A/shift-1" : "line-A/shift-2",
      event_time: `2026-08-${String(1 + (index % 28)).padStart(2, "0")}T12:00:00Z`,
      cohort: index % 5 === 0 ? "comparison" : "affected",
      evidence: family === "chamber" ? "alarm window overlaps incident window"
        : family === "material" ? "lot genealogy is available for the scoped cohort"
        : family === "inspection-artifact" ? "classification revision changed during the window"
        : "required source partition is absent for the comparison window",
      coverage: incomplete ? "missing" : family === "inspection-artifact" ? "partial" : "complete",
      uncertainty: incomplete ? ["comparison partition missing", "association cannot be evaluated"]
        : family === "inspection-artifact" ? ["classification revision differs"] : ["synthetic fixture only"],
    }
  })
}

export interface CatalogPage<T> {
  rows: T[]
  next_cursor: string | null
  coverage: { matched: number; scanned: number; scope: string; complete: boolean }
}

/** Cursor paging and scoped negative coverage model the bounded port contract. */
export function readSyntheticCatalogPage<T extends { scope: string; incident_family: string }>(
  catalog: readonly T[], request: { cursor: string | null; max_rows: number; scope: string; family?: string },
): CatalogPage<T> {
  if (!Number.isSafeInteger(request.max_rows) || request.max_rows < 1 || request.max_rows > 100)
    throw new Error("page size exceeds bounded reader contract")
  const offset = request.cursor === null ? 0 : Number(request.cursor)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > catalog.length) throw new Error("invalid catalog cursor")
  const selected = catalog.filter((row) => row.scope === request.scope &&
    (request.family === undefined || row.incident_family === request.family))
  const rows = selected.slice(offset, offset + request.max_rows)
  const next = offset + rows.length
  return {
    rows,
    next_cursor: next < selected.length ? String(next) : null,
    coverage: { matched: selected.length, scanned: catalog.length, scope: request.scope,
      complete: offset + rows.length >= selected.length },
  }
}

/** A bounded frontier keeps only the leading page of an already scoped catalog. */
export function syntheticFrontier<T extends { catalog_id: string; incident_family: string; coverage: string }>(
  rows: readonly T[], limit: number,
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("frontier limit exceeds bounded contract")
  return [...rows].sort((left, right) => {
    const incompleteness = Number(right.coverage !== "complete") - Number(left.coverage !== "complete")
    return incompleteness || left.catalog_id.localeCompare(right.catalog_id)
  }).slice(0, limit)
}
