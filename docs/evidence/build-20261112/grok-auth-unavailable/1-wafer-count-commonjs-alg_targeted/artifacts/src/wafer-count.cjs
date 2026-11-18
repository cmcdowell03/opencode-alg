"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  return rows.filter((row) => {
    const at = Date.parse(row.inspected_at);
    return Number.isFinite(at) && at >= start && at <= end;
  }).length;
}

module.exports = { countDistinctWafers };
