"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
    const start = Date.parse(startInclusive);
    const end = Date.parse(endExclusive);
    if (Number.isNaN(start) || Number.isNaN(end)) return 0;

    const filteredRows = rows.filter((row) => {
      const at = Date.parse(row.inspected_at);
      // Inclusive start (>= start) and Exclusive end (< end)
      return Number.isFinite(at) && at >= start && at < end;
    });

    const distinctWafers = new Set(filteredRows.map(row => row.wafer_id));
    return distinctWafers.size;
}

module.exports = { countDistinctWafers };
