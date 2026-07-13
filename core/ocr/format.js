// Deterministic alt-text formatting rules. Pure — no deps, unit-testable.
// The semantic rules (where to place ' | ', verbatim-only) live in the model prompt;
// these run on the model's raw output to guarantee the hard requirements.

/**
 * @param {string} raw  model/OCR raw transcription
 * @returns {string} formatted alt text safe for an alt="..." attribute
 */
export function formatAlt(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/"/g, "'");                    // 1. double quotes -> single (never break alt="...")
  s = s.replace(/[<>]/g, "");                  // 2. strip < > so no prior tag can break/close
  s = s.replace(/([A-Za-z])(\d+)/g, "$1($2)"); // 3. legal mark: number stuck to a word -> (n)
  s = s.replace(/\s*\|\s*/g, " | ");           // 4. normalise section breaks to ' | '
  s = s.replace(/[ \t]{2,}/g, " ").trim();     //    collapse runs of spaces
  return s;
}

/**
 * Build the alt.txt body: one line per slice, in the SAME grid order as
 * core/exporter/index.js sliceNames(). Empty slices produce an empty line.
 */
export function buildAltTxt(project) {
  const lines = [];
  for (const row of project.rows) {
    for (const c of row.columns) lines.push((c.alt || "").trim());
  }
  return lines.join("\n");
}
