"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  const wafers = new Set();
  rows.forEach((row) => {
    const at = Date.parse(row.inspected_at);
    if (Number.isFinite(at) && at >= start && at < end) wafers.add(row.wafer_id);
  });
  return wafers.size;
}

module.exports = { countDistinctWafers };
