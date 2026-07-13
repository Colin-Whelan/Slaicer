// Crop engine: turn a validated project + source image into numbered PNG slices.
// Writes atomically (temp dir -> rename) so a crash can't leave a half-written project.

import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { validateProject, assertTiling } from "../project.js";

/** Make a custom slice name filesystem-safe. */
function sanitize(s) {
  return s.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 80);
}

/**
 * Default slice name from its position: the padded ROW number (e.g. "015"), with a
 * `-N` column suffix only when the row is split into multiple columns ("015-1",
 * "015-2"). So slice numbers track row numbers, and a bare number means full-width.
 */
export function defaultSliceName(rowIndex, colIndex, colCount) {
  const rowNum = String(rowIndex + 1).padStart(3, "0");
  return colCount > 1 ? `${rowNum}-${colIndex + 1}` : rowNum;
}

/**
 * Compute slice filenames in grid order. A cell's `name` (if set) becomes the
 * filename; otherwise the row-based default. Collisions are de-duped
 * case-insensitively with a `-2`, `-3` suffix. Pure — unit-testable without Sharp.
 * @returns {string[]} filenames like "hero.png", "015-2.png", "003.png"
 */
export function sliceNames(project) {
  const used = new Set();
  const names = [];
  project.rows.forEach((row, ri) => {
    row.columns.forEach((c, ci) => {
      const auto = defaultSliceName(ri, ci, row.columns.length);
      let base = c.name && c.name.trim() ? sanitize(c.name) : auto;
      if (!base) base = auto; // name was all-illegal chars
      let name = base, k = 2;
      while (used.has(name.toLowerCase())) name = `${base}-${k++}`;
      used.add(name.toLowerCase());
      names.push(name + ".png");
    });
  });
  return names;
}

/**
 * Produce slice buffers in grid order (top-to-bottom, left-to-right).
 * @returns {Promise<Array<{name:string,buffer:Buffer,row:number,col:number}>>}
 */
export async function sliceImage(srcInput, project) {
  validateProject(project);
  assertTiling(project);
  const base = sharp(srcInput);
  const names = sliceNames(project);

  const slices = [];
  let idx = 0;
  for (let ri = 0; ri < project.rows.length; ri++) {
    const row = project.rows[ri];
    for (let ci = 0; ci < row.columns.length; ci++) {
      const c = row.columns[ci];
      const buffer = await base
        .clone()
        .extract({
          left: c.left,
          top: row.top,
          width: c.right - c.left,
          height: row.bottom - row.top,
        })
        .png()
        .toBuffer();
      slices.push({ name: names[idx], buffer, row: ri, col: ci });
      idx++;
    }
  }
  return slices;
}

/** Crop a single slice by grid index (cheap — avoids cropping the whole grid). */
export async function extractCell(srcInput, project, index) {
  let n = 0;
  for (const row of project.rows) {
    for (const c of row.columns) {
      if (n === index) {
        return sharp(srcInput)
          .extract({ left: c.left, top: row.top, width: c.right - c.left, height: row.bottom - row.top })
          .png()
          .toBuffer();
      }
      n++;
    }
  }
  throw new Error(`No slice at index ${index}`);
}

/**
 * Export slices + project.json into outDir/slices and outDir.
 * Atomic: builds in a sibling temp dir then renames into place.
 */
export async function exportProject(srcInput, project, outDir) {
  const slices = await sliceImage(srcInput, project);
  const tmp = outDir + ".tmp-" + Date.now();
  await fs.mkdir(path.join(tmp, "slices"), { recursive: true });

  await Promise.all(
    slices.map((s) => fs.writeFile(path.join(tmp, "slices", s.name), s.buffer))
  );
  await fs.writeFile(
    path.join(tmp, "project.json"),
    JSON.stringify(project, null, 2)
  );

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.rename(tmp, outDir);
  return { outDir, count: slices.length, names: slices.map((s) => s.name) };
}
