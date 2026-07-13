// Content-signal extraction from a raw RGB(A) buffer.
//
// For each scanline we compute the fraction of pixels that differ from the
// *page background* colour by more than `threshold`. The page background is the
// modal colour of the whole image (typically white/transparent margins). Measuring
// against this global reference — rather than each scanline's own modal — means a
// solid coloured section band reads as CONTENT (it differs from the page bg) while a
// margin/gutter scanline reads as empty. Per-scanline modal would wrongly flag both
// uniform bands and uniform gutters as "empty".

const QUANT = 4; // bucket each channel into 2^(8-4)=16 levels when finding the mode

function dist(r, g, b, br, bg, bb) {
  return Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb);
}

/**
 * Page background reference = modal colour of the *border ring* (outermost pixels).
 * The frame of an email creative is almost always the page background, whereas the
 * largest interior colour block can be a hero/section — so the ring is far more
 * reliable than the modal of the whole image.
 */
export function pageBackground(img) {
  const { data, width, height, channels } = img;
  const counts = new Map();
  let bestCount = 0;
  let bestRGB = [255, 255, 255];
  const bump = (x, y) => {
    const o = (y * width + x) * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const key = ((r >> QUANT) << 8) | ((g >> QUANT) << 4) | (b >> QUANT);
    const c = (counts.get(key) || 0) + 1;
    counts.set(key, c);
    if (c > bestCount) {
      bestCount = c;
      bestRGB = [r, g, b];
    }
  };
  for (let x = 0; x < width; x++) {
    bump(x, 0);
    bump(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    bump(0, y);
    bump(width - 1, y);
  }
  return bestRGB;
}

/** Content fraction of one scanline vs the page background. */
function scanlineContent(sample, len, bg, threshold) {
  if (len === 0) return 0;
  const [br, bgc, bb] = bg;
  const limit = threshold * 3;
  let differing = 0;
  for (let k = 0; k < len; k++) {
    const [r, g, b] = sample(k);
    if (dist(r, g, b, br, bgc, bb) > limit) differing++;
  }
  return differing / len;
}

/** Horizontal content signal: one value per image row (y). */
export function rowSignal(img, bg, threshold, x0 = 0, x1 = img.width, y0 = 0, y1 = img.height) {
  const { data, width, channels } = img;
  const out = new Array(y1 - y0);
  for (let y = y0; y < y1; y++) {
    const base = y * width * channels;
    const sample = (k) => {
      const o = base + (x0 + k) * channels;
      return [data[o], data[o + 1], data[o + 2]];
    };
    out[y - y0] = scanlineContent(sample, x1 - x0, bg, threshold);
  }
  return out;
}

/** Vertical content signal: one value per image column (x), within a y-band. */
export function colSignal(img, bg, threshold, y0, y1, x0 = 0, x1 = img.width) {
  const { data, width, channels } = img;
  const out = new Array(x1 - x0);
  for (let x = x0; x < x1; x++) {
    const sample = (k) => {
      const o = ((y0 + k) * width + x) * channels;
      return [data[o], data[o + 1], data[o + 2]];
    };
    out[x - x0] = scanlineContent(sample, y1 - y0, bg, threshold);
  }
  return out;
}
