// Client-side cropping / resizing via canvas — replaces the server's sharp calls.
import { sliceFileNames } from "./html-gen.js";

// A layer transform places a native-size image on the grid: drawn at offset
// (x, y) in grid px, scaled by `scale`. Identity = { x: 0, y: 0, scale: 1 }.
const T = (t) => ({ x: t?.x || 0, y: t?.y || 0, scale: t?.scale || 1 });

/** Crop a grid-px region of an <img> to PNG bytes, honouring a layer transform. */
export function cropSlice(image, { left, top, width, height }, transform) {
  const { x, y, scale } = T(transform);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  // Map the grid rect back into source-image pixels; off-image areas stay transparent.
  c.getContext("2d").drawImage(
    image,
    (left - x) / scale, (top - y) / scale, width / scale, height / scale,
    0, 0, width, height
  );
  return new Promise((resolve) =>
    c.toBlob((b) => b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))), "image/png")
  );
}

/** Resize an <img> to w×h, returning a PNG Blob. */
export function resizeImage(image, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(image, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

/** Base64 PNG of a single slice (for OCR). */
export async function cropSliceB64(image, rect, transform) {
  const bytes = await cropSlice(image, rect, transform);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Rect (grid px) for a slice at grid index. */
export function sliceRect(project, index) {
  let n = 0;
  for (const row of project.rows) {
    for (const col of row.columns) {
      if (n++ === index) return { left: col.left, top: row.top, width: col.right - col.left, height: row.bottom - row.top };
    }
  }
  return null;
}

/**
 * Flatten all visible layers onto a grid-sized canvas, bottom -> top, honouring each
 * layer's offset/scale and opacity (blend) — exactly what the canvas shows. Layers
 * with visible=false or 0 opacity contribute nothing (treated as hidden).
 */
export function compositeLayers(project, layers) {
  const c = document.createElement("canvas");
  c.width = project.width;
  c.height = project.height;
  const cx = c.getContext("2d");
  for (const l of layers) {
    if (!l.image || l.visible === false) continue;
    const op = l.opacity ?? 1;
    if (op <= 0) continue; // 0% opacity == hidden
    cx.globalAlpha = op;
    const s = l.scale || 1;
    cx.drawImage(l.image, l.x || 0, l.y || 0, l.image.naturalWidth * s, l.image.naturalHeight * s);
  }
  cx.globalAlpha = 1;
  return c;
}

/** Crop a grid-px sub-rect out of an already-composited canvas (1:1, no scaling). */
function cropFromCanvas(src, { left, top, width, height }) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d").drawImage(src, left, top, width, height, 0, 0, width, height);
  return new Promise((resolve) =>
    c.toBlob((b) => b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))), "image/png")
  );
}

/** All slices as { name, bytes } in grid order, cut from the flattened visible layers. */
export async function exportSlices(project, layers) {
  const names = sliceFileNames(project);
  const composite = compositeLayers(project, layers);
  const out = [];
  let i = 0;
  for (const row of project.rows) {
    for (const col of row.columns) {
      const bytes = await cropFromCanvas(composite, { left: col.left, top: row.top, width: col.right - col.left, height: row.bottom - row.top });
      out.push({ name: names[i++], bytes });
    }
  }
  return out;
}
