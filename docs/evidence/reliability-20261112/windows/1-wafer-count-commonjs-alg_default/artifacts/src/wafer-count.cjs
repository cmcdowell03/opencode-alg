"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  const matchingRows = rows.filter((row) => {
    const at = Date.parse(row.inspected_at);
    return Number.isFinite(at) && at >= start && at < end;
  });
  return new Set(matchingRows.map((row) => row.wafer_id)).size;
}

module.exports = { countDistinctWafers };
