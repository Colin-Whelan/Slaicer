// Pure email-HTML generator. No DOM. Unit-tested.
//
// The shell + cell markup are HARDCODED (opinionated, table-based: one <table> per row
// so logic sits between tables, not <tr>s). A config only supplies variables:
//   { name, companyName, width, baseUrl, autoAppendParams, header, footer }
// Slices are usually 2x res, so the displayed img width is scaled to the template width.

function sanitize(s) {
  return s.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 80);
}

/** Slice filenames in grid order — mirrors core/exporter/index.js sliceNames(). */
export function sliceFileNames(project) {
  const used = new Set();
  const names = [];
  project.rows.forEach((row, ri) => {
    row.columns.forEach((c, ci) => {
      const rowNum = String(ri + 1).padStart(3, "0");
      const auto = row.columns.length > 1 ? `${rowNum}-${ci + 1}` : rowNum;
      let base = c.name && c.name.trim() ? sanitize(c.name) : auto;
      if (!base) base = auto;
      let name = base, k = 2;
      while (used.has(name.toLowerCase())) name = `${base}-${k++}`;
      used.add(name.toLowerCase());
      names.push(name + ".png");
    });
  });
  return names;
}

const escAttr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tok = (name) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g");
const fill = (str, name, val) => str.replace(tok(name), () => val);

export function appendParams(link, params) {
  const p = (params || "").replace(/^[?&]+/, "").trim();
  if (!p) return link;
  return link + (link.includes("?") ? "&" : "?") + p;
}

// --- hardcoded, opinionated markup ------------------------------------------

const SHELL = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <!--[if gte mso 9]>
    <xml>
    <o:OfficeDocumentSettings>
    <o:AllowPNG/>
    <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
    </xml>
    <![endif]-->
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0" />
    <meta name="format-detection" content="telephone=no" />
    <meta charset="UTF-8">
    <title>{{company_name}}</title>
    <style type="text/css">
    * {
    box-sizing: border-box !important;
    -moz-box-sizing: border-box !important;
    -webkit-box-sizing: border-box !important;
    }
    body {
    width: 100% !important;
    padding: 0;
    -webkit-text-size-adjust:none;
    }
    .ExternalClass { width: 100%; }
    .ExternalClass, .ExternalClass p, .ExternalClass span, .ExternalClass font, .ExternalClass td, .ExternalClass div { line-height: 100%; }
    a[x-apple-data-detectors] {
    color: inherit !important;
    text-decoration: none !important;
    font-size: inherit !important;
    font-family: inherit !important;
    font-weight: inherit !important;
    line-height: inherit !important;
    }
    @media only screen and (max-width: 599px) {
    .w100 { width: 100% !important;}
    .w75 { width: 75% !important;}
    .w60 { width: 60% !important;}
    .w50 { width: 50% !important;}
    .w40 { width: 40% !important;}
    .w33 { width: 33% !important;}
    .w25 { width: 25% !important;}
    .hide { display: none !important; }
    .resize { max-width: 100% !important; height: auto !important; width: 100% !important; }
    .resize2 { width: 100% !important; height: auto !important; }
    .resize3 { height: auto !important; }
    .expand { width: 100% !important; display: block !important; }
    .expand2 { display: block !important; }
    .block { display: block !important; }
    .centerm { text-align: center !important; }
    }
    </style>
  </head>
    <div style="display: none; max-height: 0px; overflow: hidden;">
      {{preview}}
    </div>
  <body style="margin:0px; padding:0px;" bgcolor="#ffffff" lang="en">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"  bgcolor="#ffffff" role="presentation">
      <tr>
        <td valign="top" align="center">
          <table border="0" cellpadding="0" cellspacing="0" width="{{page_width}}" class="w100" role="presentation">
            <tr>
              <td align="center">
{{body}}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

// One <td> per column. {{col_pct}} is set from the row layout; the <a> wrapping
// {{slicer_link}} is stripped when a slice has no link.
const CELL = `<td align="center" width="{{col_pct}}">
  <a href="{{slicer_link}}" target="_blank" style="color: #0926bb; text-decoration: underline;">
    <img src="{{slicer_src}}" width="{{slicer_w}}" border="0" alt="{{slicer_alt}}" style="display: block;" class="resize" />
  </a>
</td>`;

const ROW = `<table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation">
  <tr>
{{cells}}
  </tr>
</table>`;

function stripAnchor(cell) {
  return cell.replace(/<a\b[^>]*\{\{\s*slicer_link\s*\}\}[^>]*>/i, "").replace(/\s*<\/a>/i, "");
}

function cellHtml({ src, alt, link, w, pct, params }) {
  let c = CELL;
  if (link) c = fill(c, "slicer_link", escAttr(appendParams(link, params)));
  else { c = stripAnchor(c); c = fill(c, "slicer_link", ""); }
  c = fill(c, "slicer_src", escAttr(src));
  c = fill(c, "slicer_alt", escAttr(alt || "")); // null alt -> alt=""
  c = fill(c, "slicer_w", String(w));
  c = fill(c, "col_pct", pct);
  return c;
}

/**
 * @param {object} project
 * @param {object} config  { companyName, width, baseUrl, autoAppendParams, header, footer }
 * @param {object} meta    { subject, preview, preheader }
 * @returns {{ html: string, warnings: string[] }}
 */
export function generateHtml(project, config = {}, meta = {}) {
  const names = sliceFileNames(project);
  const pageWidth = Number(config.width) || 600;
  const scale = pageWidth / project.width; // 2x source -> display width
  const baseUrl = config.baseUrl || "";

  let n = 0;
  const rowTables = [];
  for (const row of project.rows) {
    const cols = [];
    for (const col of row.columns) {
      const i = n++;
      if (col.include === false) continue;
      const cw = col.right - col.left;
      cols.push(cellHtml({
        src: baseUrl + names[i],
        alt: col.alt,
        link: col.link && col.link.trim() ? col.link.trim() : null,
        w: Math.round(cw * scale),
        pct: cols.length === 0 && row.columns.length === 1 ? "100%" : `${Math.round((cw / project.width) * 100)}%`,
        params: config.autoAppendParams,
      }));
    }
    if (cols.length) rowTables.push(fill(ROW, "cells", cols.join("\n")));
  }

  const body = [config.header || "", ...rowTables, config.footer || ""].filter(Boolean).join("\n");
  const preview = (meta.preheader && meta.preheader.trim()) || meta.preview || "";

  let html = SHELL;
  html = fill(html, "company_name", escText(config.companyName || meta.subject || ""));
  html = fill(html, "page_width", String(pageWidth));
  html = fill(html, "preview", escText(preview));
  html = fill(html, "body", body);

  const warnings = [];
  if (!rowTables.length) warnings.push("No slices are included in the build.");
  if (project.width % pageWidth !== 0 && pageWidth !== project.width) {
    warnings.push(`Image width ${project.width}px is not a clean multiple of template width ${pageWidth}px — check the 2x scale.`);
  }
  return { html, warnings };
}
