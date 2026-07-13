// Layout snapping — labels a row's columns against known templates.
// By default this only produces a *label*; it never moves pixel boundaries.

import layoutsData from "../../shared/layouts.json" with { type: "json" };

// The only fractions a column boundary may sit on. Columns can never deviate from
// these — both at detection time and when the user drags in the UI.
export const SNAP_FRACTIONS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];

/** Nearest allowed absolute x for a boundary in a row of the given width. */
export function snapColumnX(x, width) {
  let best = Math.round(width * SNAP_FRACTIONS[0]);
  let bestErr = Infinity;
  for (const f of SNAP_FRACTIONS) {
    const px = Math.round(width * f);
    const err = Math.abs(px - x);
    if (err < bestErr) {
      bestErr = err;
      best = px;
    }
  }
  return best;
}

/**
 * Snap a set of detected interior column boundaries onto the allowed grid.
 * Collapses duplicates so the result stays strictly increasing.
 * @returns {number[]} cleaned, sorted, unique boundary x positions
 */
export function snapColumnBoundaries(boundaries, width) {
  const snapped = [...new Set(boundaries.map((b) => snapColumnX(b, width)))]
    .filter((b) => b > 0 && b < width)
    .sort((a, b) => a - b);
  return snapped;
}

/**
 * @param {Array<{left:number,right:number}>} columns
 * @param {number} rowWidth        total width the columns span
 * @param {number} tolerance       max fractional width error to accept a template
 * @param {object} layouts         { templates: [{label, weights}] }
 * @returns {string} matched template label, or "custom"
 */
export function snapLayout(columns, rowWidth, tolerance, layouts = layoutsData) {
  if (columns.length === 1) return "100";
  const actual = columns.map((c) => (c.right - c.left) / rowWidth);

  let best = "custom";
  let bestErr = Infinity;
  for (const t of layouts.templates) {
    if (t.weights.length !== columns.length) continue;
    const sum = t.weights.reduce((a, b) => a + b, 0);
    const expected = t.weights.map((w) => w / sum);
    let err = 0;
    for (let i = 0; i < expected.length; i++) {
      err = Math.max(err, Math.abs(expected[i] - actual[i]));
    }
    if (err <= tolerance && err < bestErr) {
      bestErr = err;
      best = t.label;
    }
  }
  return best;
}
