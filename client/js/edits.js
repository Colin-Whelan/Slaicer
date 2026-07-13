// Pure geometry edits on the project object. Every edit keeps the tiling invariant
// (rows tile height, columns tile each row's width) and marks touched rows `locked`
// so a later server re-detect won't move them.

const MIN = 8; // minimum row height in image px

// Column boundaries may ONLY sit on these fractions of the row width — never between.
const SNAP_FRACTIONS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];

/** Allowed absolute column-boundary x positions, ascending. */
function snapPoints(width) {
  return SNAP_FRACTIONS.map((f) => Math.round(width * f)).sort((a, b) => a - b);
}

/** Nearest allowed x strictly inside (lo, hi); null if none fits. */
function nearestSnap(x, width, lo, hi) {
  let best = null, bestErr = Infinity;
  for (const p of snapPoints(width)) {
    if (p <= lo || p >= hi) continue;
    const err = Math.abs(p - x);
    if (err < bestErr) { bestErr = err; best = p; }
  }
  return best;
}

export function reindex(project) {
  project.rows.forEach((r, ri) => {
    r.id = `r${ri + 1}`;
    r.columns.forEach((c, ci) => (c.id = `r${ri + 1}c${ci + 1}`));
    r.layout = labelFor(r.columns, project.width);
  });
  return project;
}

function labelFor(cols, width) {
  if (cols.length === 1) return "100";
  return cols.map((c) => Math.round(((c.right - c.left) / width) * 100)).join("/");
}

function singleColumn(width) {
  return [{ id: "c", left: 0, right: width, link: null, alt: null }];
}

function cloneCols(cols) {
  return cols.map((c) => ({ id: "", left: c.left, right: c.right, name: c.name ?? null, link: null, alt: null }));
}

// Union of all interior column cuts across `rows` -> columns spanning full width.
// So merging rows keeps every vertical slice (each extends to fill the merged band).
// Names carried over when a cell's [left,right] matches a source cell exactly.
function mergeColumns(rows, width) {
  const cuts = new Set();
  for (const r of rows) for (let j = 1; j < r.columns.length; j++) cuts.add(r.columns[j].left);
  const edges = [0, ...[...cuts].filter((c) => c > 0 && c < width).sort((a, b) => a - b), width];
  return edges.slice(0, -1).map((left, k) => {
    const right = edges[k + 1];
    let name = null;
    for (const r of rows) {
      const m = r.columns.find((c) => c.left === left && c.right === right && c.name);
      if (m) { name = m.name; break; }
    }
    return { id: "", left, right, name, link: null, alt: null };
  });
}

/**
 * Re-fit rows/columns to a new image size, anchored TOP-LEFT (slice positions stay
 * fixed from the top). Overflow is clipped; last row/column stretches to fill.
 * Mirrors core/project.js clampToSize for use when replacing a tab's image.
 */
export function clampToSize(project, width, height) {
  let rows = project.rows
    .filter((r) => r.top < height)
    .map((r) => ({ ...r, bottom: Math.min(r.bottom, height), columns: r.columns.map((c) => ({ ...c })) }))
    .filter((r) => r.bottom > r.top);
  if (rows.length === 0) rows = [{ top: 0, bottom: height, columns: [], layout: "100", locked: false }];
  rows[rows.length - 1].bottom = height;
  rows.forEach((r) => {
    let cols = r.columns.filter((c) => c.left < width).map((c) => ({ ...c, right: Math.min(c.right, width) }));
    if (cols.length === 0) cols = [{ left: 0, right: width, link: null, alt: null }];
    cols[0].left = 0;
    cols[cols.length - 1].right = width;
    r.columns = cols;
  });
  project.rows = rows;
  project.width = width;
  project.height = height;
  return reindex(project);
}

/**
 * Scale the whole template (grid + canvas size) by factor k. Rebuilt from scaled
 * edge lists so the tiling invariant survives rounding (rows still tile height,
 * columns still tile each row's width).
 */
export function scaleProject(project, k) {
  const W = Math.round(project.width * k), H = Math.round(project.height * k);
  const rowEdges = [0, ...project.rows.map((r) => Math.round(r.bottom * k))];
  rowEdges[rowEdges.length - 1] = H;
  project.rows.forEach((r, i) => {
    r.top = rowEdges[i];
    r.bottom = rowEdges[i + 1];
    const colEdges = [0, ...r.columns.map((c) => Math.round(c.right * k))];
    colEdges[colEdges.length - 1] = W;
    r.columns.forEach((c, j) => { c.left = colEdges[j]; c.right = colEdges[j + 1]; });
  });
  project.width = W;
  project.height = H;
  return reindex(project);
}

// --- rows -------------------------------------------------------------------

export function moveRowBoundary(project, i, y) {
  // boundary between rows[i-1] and rows[i]
  const above = project.rows[i - 1], below = project.rows[i];
  const clamped = Math.max(above.top + MIN, Math.min(below.bottom - MIN, Math.round(y)));
  above.bottom = clamped;
  below.top = clamped;
  above.locked = below.locked = true;
  return reindex(project);
}

export function addRowBoundary(project, y) {
  const yy = Math.round(y);
  const k = project.rows.findIndex((r) => yy > r.top + MIN && yy < r.bottom - MIN);
  if (k === -1) return project;
  const row = project.rows[k];
  const top = row.top, bottom = row.bottom;
  // Both halves inherit the row's vertical slices.
  const a = { id: "", top, bottom: yy, columns: cloneCols(row.columns), layout: "100", locked: true };
  const b = { id: "", top: yy, bottom, columns: cloneCols(row.columns), layout: "100", locked: true };
  project.rows.splice(k, 1, a, b);
  return reindex(project);
}

/**
 * Move several row boundaries together by `dy` (image px) from a snapshot of their
 * original tops. Only vertical movement. Clamps `dy` so every moved boundary stays
 * between its nearest *unselected* neighbours (min gap MIN), preserving order.
 * @param {Set<number>} sel        boundary indices being moved
 * @param {Map<number,number>} snapshot  boundary index -> original top
 */
export function moveRowGroup(project, sel, snapshot, dy) {
  const rows = project.rows;
  const n = rows.length;
  let lo = -Infinity, hi = Infinity;
  for (const i of sel) {
    let below = 0;
    for (let j = i - 1; j >= 1; j--) if (!sel.has(j)) { below = rows[j].top; break; }
    let above = project.height;
    for (let j = i + 1; j <= n - 1; j++) if (!sel.has(j)) { above = rows[j].top; break; }
    lo = Math.max(lo, below + MIN - snapshot.get(i));
    hi = Math.min(hi, above - MIN - snapshot.get(i));
  }
  const d = Math.max(lo, Math.min(hi, dy));
  for (const i of sel) {
    const top = Math.round(snapshot.get(i) + d);
    rows[i].top = top;
    rows[i - 1].bottom = top;
    rows[i].locked = rows[i - 1].locked = true;
  }
  return reindex(project);
}

/**
 * Remove several row boundaries at once. Rows whose boundaries are removed merge
 * together (collapsing to a single column, since their column sets conflict), but
 * every UNTOUCHED row keeps its columns exactly — so vertical slices outside the
 * affected region are never disturbed.
 */
export function removeRowBoundaries(project, sel) {
  const rows = project.rows;
  const out = [];
  let group = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (sel.has(i)) group.push(rows[i]); // boundary i removed -> rows i-1,i merge
    else { out.push(mergeGroup(group, project.width)); group = [rows[i]]; }
  }
  out.push(mergeGroup(group, project.width));
  project.rows = out;
  return reindex(project);
}

function mergeGroup(group, width) {
  if (group.length === 1) return group[0]; // untouched row: keep its columns as-is
  return {
    id: "", top: group[0].top, bottom: group[group.length - 1].bottom,
    columns: mergeColumns(group, width), layout: "100", locked: true, // vert slices survive
  };
}

/** Remove a set of column boundaries from one row (merges those cells). */
export function removeColumns(project, ri, jSet) {
  const row = project.rows[ri];
  const edges = [0];
  for (let j = 1; j < row.columns.length; j++) if (!jSet.has(j)) edges.push(row.columns[j].left);
  edges.push(project.width);
  row.columns = edges.slice(0, -1).map((l, k) => ({ left: l, right: edges[k + 1], link: null, alt: null }));
  row.locked = true;
  return row;
}

/**
 * Remove a rubber-band selection: the chosen column boundaries (keyed "ri:j") AND
 * the chosen row boundaries — leaving every other slice untouched.
 * Columns are removed first (row indices unchanged), then rows merge.
 */
export function removeSelection(project, selRows, selCols) {
  const byRow = new Map();
  for (const key of selCols) {
    const [ri, j] = key.split(":").map(Number);
    if (!byRow.has(ri)) byRow.set(ri, new Set());
    byRow.get(ri).add(j);
  }
  for (const [ri, jSet] of byRow) removeColumns(project, ri, jSet);
  if (selRows.size) removeRowBoundaries(project, selRows);
  else reindex(project);
  return project;
}

export function removeRowBoundary(project, i) {
  if (project.rows.length <= 1 || i < 1 || i >= project.rows.length) return project;
  const above = project.rows[i - 1], below = project.rows[i];
  const merged = {
    id: "", top: above.top, bottom: below.bottom,
    columns: mergeColumns([above, below], project.width), layout: "100", locked: true,
  };
  project.rows.splice(i - 1, 2, merged);
  return reindex(project);
}

// --- columns (within one row) ----------------------------------------------

export function moveColBoundary(project, ri, j, x) {
  const row = project.rows[ri];
  const left = row.columns[j - 1], right = row.columns[j];
  // Boundary can only land on a snap point between its neighbours.
  const snapped = nearestSnap(x, project.width, left.left, right.right);
  if (snapped === null) return project; // no allowed point fits — leave as-is
  left.right = snapped;
  right.left = snapped;
  row.locked = true;
  return reindex(project);
}

/** Reset a row back to a single full-width column (drops its vertical slices). */
export function clearColumns(project, ri) {
  project.rows[ri].columns = singleColumn(project.width);
  project.rows[ri].locked = true;
  return reindex(project);
}

export function addColBoundary(project, ri, x) {
  const row = project.rows[ri];
  // Snap the requested position to the grid, then split whichever column holds it.
  const snapped = nearestSnap(x, project.width, 0, project.width);
  if (snapped === null) return project;
  const k = row.columns.findIndex((c) => snapped > c.left && snapped < c.right);
  if (k === -1) return project; // snap point coincides with an existing boundary
  const c = row.columns[k];
  const a = { id: "", left: c.left, right: snapped, link: null, alt: null };
  const b = { id: "", left: snapped, right: c.right, link: null, alt: null };
  row.columns.splice(k, 1, a, b);
  row.locked = true;
  return reindex(project);
}

export function removeColBoundary(project, ri, j) {
  const row = project.rows[ri];
  if (row.columns.length <= 1 || j < 1 || j >= row.columns.length) return project;
  const left = row.columns[j - 1], right = row.columns[j];
  const merged = { left: left.left, right: right.right, link: null, alt: null };
  row.columns.splice(j - 1, 2, merged);
  row.locked = true;
  return reindex(project);
}
