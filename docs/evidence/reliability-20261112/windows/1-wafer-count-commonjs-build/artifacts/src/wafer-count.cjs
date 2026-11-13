"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  return new Set(rows.filter((row) => {
    const at = Date.parse(row.inspected_at);
    return Number.isFinite(at) && at >= start && at < end;
  }).map((row) => row.wafer_id)).size;
}

module.exports = { countDistinctWafers };
