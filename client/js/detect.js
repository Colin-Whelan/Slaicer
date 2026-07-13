// Client-side detection. Runs the PURE detector (served from /core) on the browser
// canvas's pixels — no server, no sharp. The detector reads r/g/b by stride, so RGBA
// (channels: 4) from getImageData works unchanged.

import { detect, redetect } from "/core/detector/index.js";

function imageData(image) {
  const c = document.createElement("canvas");
  c.width = image.naturalWidth;
  c.height = image.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: c.width, height: c.height, channels: 4 };
}

// Mirror of core/project.js assertTiling — guards off-by-one bugs without pulling ajv.
export function assertTiling(project) {
  const { width, height, rows } = project;
  if (!rows.length) throw new Error("Project has no rows");
  let y = 0;
  for (const row of rows) {
    if (row.top !== y) throw new Error(`Row ${row.id} gap/overlap`);
    let x = 0;
    for (const c of row.columns) {
      if (c.left !== x) throw new Error(`Col ${c.id} gap/overlap`);
      x = c.right;
    }
    if (x !== width) throw new Error(`Row ${row.id} columns span ${x} != ${width}`);
    y = row.bottom;
  }
  if (y !== height) throw new Error(`Rows span ${y} != image height ${height}`);
  return project;
}

/** Detect a fresh project from an <img> element. */
export function detectProject(image, name, rules = {}) {
  const img = imageData(image);
  const rows = detect(img, rules);
  const project = { version: 1, image: name, width: img.width, height: img.height, rules, rows };
  assertTiling(project);
  return project;
}

/** Re-detect, preserving locked rows, from an <img> element + the current project. */
export function redetectProject(image, project, rules = {}) {
  const img = imageData(image);
  const rows = redetect(img, project.rows, rules);
  const next = { version: 1, image: project.image, width: img.width, height: img.height, rules, rows };
  assertTiling(next);
  return next;
}
