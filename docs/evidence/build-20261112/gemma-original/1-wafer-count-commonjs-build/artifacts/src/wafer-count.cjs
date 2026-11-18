"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  let distinctWafers = new Set();
  for (const row of rows) {
    const at = Date.parse(row.inspected_at);
    if (Number.isFinite(at) && at >= start && at < end) {
      distinctWafers.add(row.wafer_id);
    }
  }
  return distinctWafers.size;
}

module.exports = { countDistinctWafers };
