// Assembles a full project.json object from an image + detected rows, and
// validates it against the shared schema. The project object is the single
// source of truth that the UI, CLI, exporter, and AI all read/write.

import Ajv from "ajv";
import schema from "../shared/schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true });
const validateFn = ajv.compile(schema);

/**
 * @param {string} imageName       basename stored in the project (e.g. "input.png")
 * @param {{width:number,height:number}} img
 * @param {Array} rows             detector output
 * @param {object} rules           rules used for the scan
 */
export function buildProject(imageName, img, rows, rules = {}) {
  return {
    version: 1,
    image: imageName,
    width: img.width,
    height: img.height,
    rules,
    rows,
  };
}

/**
 * Re-fit an existing project's rows/columns to a new image size, anchored to the
 * TOP-LEFT (slice positions stay fixed from the top). Rows/columns past the new
 * bounds are clipped; the last row/column is stretched to fill exactly so the
 * result still tiles. Used when an image is replaced with a different-sized one.
 */
export function clampToSize(project, width, height) {
  let rows = project.rows
    .filter((r) => r.top < height)
    .map((r) => ({ ...r, bottom: Math.min(r.bottom, height), columns: r.columns.map((c) => ({ ...c })) }))
    .filter((r) => r.bottom > r.top);
  if (rows.length === 0) {
    rows = [{ id: "r1", top: 0, bottom: height, columns: [], layout: "100", locked: false }];
  }
  rows[rows.length - 1].bottom = height; // stretch last row to the new bottom

  rows.forEach((r, ri) => {
    let cols = r.columns.filter((c) => c.left < width).map((c) => ({ ...c, right: Math.min(c.right, width) }));
    if (cols.length === 0) cols = [{ left: 0, right: width, link: null, alt: null }];
    cols[0].left = 0;
    cols[cols.length - 1].right = width; // stretch last column to the new right
    r.columns = cols.map((c, ci) => ({ ...c, id: `r${ri + 1}c${ci + 1}` }));
    r.id = `r${ri + 1}`;
  });

  return { ...project, width, height, rows };
}

/** Throws with readable messages if the project violates the schema. */
export function validateProject(project) {
  if (!validateFn(project)) {
    const msg = (validateFn.errors || [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
      .join("; ");
    throw new Error(`Invalid project: ${msg}`);
  }
  return project;
}

/**
 * Structural sanity beyond JSON Schema: rows must tile the image height with no
 * gaps/overlaps, and columns must tile each row's width. Catches off-by-one bugs.
 */
export function assertTiling(project) {
  const { width, height, rows } = project;
  if (rows.length === 0) throw new Error("Project has no rows");
  let y = 0;
  for (const row of rows) {
    if (row.top !== y) throw new Error(`Row ${row.id} gap/overlap: top ${row.top} != ${y}`);
    if (row.bottom <= row.top) throw new Error(`Row ${row.id} non-positive height`);
    let x = 0;
    for (const c of row.columns) {
      if (c.left !== x) throw new Error(`Col ${c.id} gap/overlap: left ${c.left} != ${x}`);
      if (c.right <= c.left) throw new Error(`Col ${c.id} non-positive width`);
      x = c.right;
    }
    if (x !== width) throw new Error(`Row ${row.id} columns span ${x} != ${width}`);
    y = row.bottom;
  }
  if (y !== height) throw new Error(`Rows span ${y} != image height ${height}`);
  return project;
}
