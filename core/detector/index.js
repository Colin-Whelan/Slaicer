// The detection engine: a pure function (image + rules) -> rows[].
// No Express, no filesystem, no browser. Same engine powers UI, CLI, and batch.

import defaultRules from "../../shared/rules.json" with { type: "json" };
import { rowSignal, colSignal, pageBackground } from "./signal.js";
import { segment1D } from "./segment.js";
import { snapLayout, snapColumnBoundaries } from "./snap.js";

/**
 * @param {{data:Buffer,width:number,height:number,channels:number}} img  raw RGB buffer
 * @param {object} [userRules]   overrides merged over shared/rules.json
 * @returns {Array} rows[] per shared/schema.json
 */
export function detect(img, userRules = {}) {
  const rules = { ...defaultRules, ...userRules };
  const { height } = img;
  const bg = pageBackground(img);

  const yStart = clamp(rules.ignoreTop | 0, 0, height);
  const yEnd = clamp(height - (rules.ignoreBottom | 0), 0, height);

  return reindex(detectBand(img, rules, bg, yStart, yEnd));
}

/**
 * Re-detect while preserving user-locked rows. Locked rows keep their exact
 * boundaries and columns; only the unlocked bands *between* them are re-scanned.
 * This guarantees the result still tiles the image — fresh rows are generated to
 * fill each gap exactly, so boundaries always meet.
 */
export function redetect(img, prevRows, userRules = {}) {
  const rules = { ...defaultRules, ...userRules };
  const { height } = img;
  const bg = pageBackground(img);

  const locked = prevRows
    .filter((r) => r.locked)
    .map(cloneRow)
    .sort((a, b) => a.top - b.top);
  if (locked.length === 0) return detect(img, userRules);

  const out = [];
  let cursor = 0;
  for (const lr of locked) {
    if (lr.top > cursor) out.push(...detectBand(img, rules, bg, cursor, lr.top));
    out.push(lr);
    cursor = lr.bottom;
  }
  if (cursor < height) out.push(...detectBand(img, rules, bg, cursor, height));
  return reindex(out);
}

// --- internals --------------------------------------------------------------

/** Detect rows that tile exactly [y0, y1). Each row gets its columns. */
function detectBand(img, rules, bg, y0, y1) {
  const { width } = img;
  if (y1 - y0 <= 0) return [];

  const rSig = rowSignal(img, bg, rules.threshold, 0, width, y0, y1);
  const rowSegs = segment1D(rSig, {
    minContent: rules.minContent,
    minGutter: rules.minGutter,
    minSegment: rules.minimumRowHeight,
  }).map(([s, e]) => [s + y0, e + y0]); // re-base to absolute y

  return rowSegs.map(([top, bottom]) => buildRow(img, rules, bg, top, bottom));
}

/** Build one row (column detection + snapping). Ids/layout assigned in reindex(). */
function buildRow(img, rules, bg, top, bottom) {
  const { width } = img;
  let cols;
  if (rules.detectColumns) {
    // Columns use their own (less sensitive) thresholds so vertical cuts are rarer.
    const colThreshold = rules.colThreshold ?? rules.threshold;
    const cSig = colSignal(img, bg, colThreshold, top, bottom, 0, width);
    cols = segment1D(cSig, {
      minContent: rules.colMinContent ?? rules.minContent,
      minGutter: rules.colMinGutter ?? rules.minGutter,
      minSegment: rules.minimumColumnWidth,
    });
    if (rules.snapColumns && cols.length > 1) {
      const interior = cols.slice(1).map(([l]) => l);
      const snapped = snapColumnBoundaries(interior, width).filter(
        (b) => b >= rules.minimumColumnWidth && width - b >= rules.minimumColumnWidth
      );
      const edges = [0, ...snapped, width];
      cols = edges.slice(0, -1).map((l, k) => [l, edges[k + 1]]);
    }
  } else {
    cols = [[0, width]];
  }

  const columns = cols.map(([left, right]) => ({ id: "", left, right, link: null, alt: null }));
  return { id: "", top, bottom, columns, layout: "100", locked: false };
}

function reindex(rows) {
  return rows.map((r, ri) => {
    const columns = r.columns.map((c, ci) => ({ ...c, id: `r${ri + 1}c${ci + 1}` }));
    return {
      ...r,
      id: `r${ri + 1}`,
      columns,
      layout: snapLayout(columns, columns[columns.length - 1].right, 0.04),
    };
  });
}

function cloneRow(r) {
  return { ...r, columns: r.columns.map((c) => ({ ...c })) };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
