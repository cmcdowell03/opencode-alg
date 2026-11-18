"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  const waferIds = new Set();
  rows.forEach((row) => {
    const at = Date.parse(row.inspected_at);
    if (Number.isFinite(at) && at >= start && at < end) {
      waferIds.add(row.wafer_id);
    }
  });
  return waferIds.size;
}

module.exports = { countDistinctWafers };
