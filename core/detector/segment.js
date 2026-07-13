// Pure 1D segmentation. No image knowledge — operates on a content signal array.
//
// `signal[i]` is the "content fraction" of scanline i (0 = empty/background,
// 1 = fully differs from background). We cut at the centre of interior low-content
// runs (gutters) and return segments that fully tile [0, length) with no gaps/overlap.

/**
 * @param {number[]} signal        content fraction per scanline, length N
 * @param {object} opts
 * @param {number} opts.minContent  below this a scanline counts as a gutter
 * @param {number} opts.minGutter   a gutter run must be at least this long to cut
 * @param {number} opts.minSegment  segments shorter than this get merged away
 * @returns {Array<[number, number]>} segments as [start, end) covering [0, length)
 */
export function segment1D(signal, { minContent, minGutter, minSegment }) {
  const N = signal.length;
  if (N === 0) return [];

  // 1. Find runs of consecutive gutter scanlines.
  const gutterRuns = [];
  let runStart = -1;
  for (let i = 0; i < N; i++) {
    const isGutter = signal[i] < minContent;
    if (isGutter && runStart === -1) runStart = i;
    if (!isGutter && runStart !== -1) {
      gutterRuns.push([runStart, i]); // [start, end)
      runStart = -1;
    }
  }
  if (runStart !== -1) gutterRuns.push([runStart, N]);

  // 2. Cut at the centre of *interior* gutter runs that are long enough.
  //    Runs touching index 0 or the end are margins, not separators.
  const cuts = [];
  for (const [start, end] of gutterRuns) {
    const touchesEdge = start === 0 || end === N;
    if (touchesEdge) continue;
    if (end - start < minGutter) continue;
    cuts.push(Math.round((start + end) / 2));
  }

  // 3. Build segments from cuts.
  let segments = [];
  let prev = 0;
  for (const c of cuts) {
    segments.push([prev, c]);
    prev = c;
  }
  segments.push([prev, N]);

  // 4. Merge segments shorter than minSegment into a neighbour.
  segments = mergeSmall(segments, minSegment);
  return segments;
}

function mergeSmall(segments, minSegment) {
  if (!minSegment || segments.length <= 1) return segments;
  const out = segments.map((s) => [...s]);
  let i = 0;
  while (out.length > 1 && i < out.length) {
    const [start, end] = out[i];
    if (end - start >= minSegment) {
      i++;
      continue;
    }
    // Merge into the shorter-adjacent neighbour to keep boundaries sensible.
    if (i === 0) {
      out[1][0] = out[0][0];
      out.splice(0, 1);
    } else if (i === out.length - 1) {
      out[i - 1][1] = out[i][1];
      out.splice(i, 1);
      i--;
    } else {
      const left = out[i - 1][1] - out[i - 1][0];
      const right = out[i + 1][1] - out[i + 1][0];
      if (left <= right) {
        out[i - 1][1] = out[i][1];
        out.splice(i, 1);
        i--;
      } else {
        out[i + 1][0] = out[i][0];
        out.splice(i, 1);
      }
    }
  }
  return out;
}
