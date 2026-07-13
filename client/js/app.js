import * as E from "./edits.js";
import * as PF from "./project-file.js";
import { IS_LOCAL } from "./config.js";
import { makeZip } from "./zip.js";
import { generateHtml } from "./html-gen.js";
import * as Configs from "./configs.js";
import { detectProject, redetectProject } from "./detect.js";
import { exportSlices, cropSliceB64, sliceRect } from "./crop.js";
import * as OCR from "./ocr.js";
import { buildAltTxt } from "/core/ocr/format.js";

/** Load an image URL into an <img> element. */
function loadImg(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}

// Ace code editor (loaded via CDN <script>). Small wrapper for our HTML fields.
function makeAce(id, { readOnly = false, onChange } = {}) {
  ace.config.set("basePath", "https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/");
  const ed = ace.edit(id, {
    mode: "ace/mode/html", theme: "ace/theme/tomorrow_night",
    wrap: true, showPrintMargin: false, useWorker: false, fontSize: 12,
    readOnly, highlightActiveLine: !readOnly, tabSize: 2,
  });
  if (onChange) ed.on("change", onChange);
  return ed;
}

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const stage = $("stage");

const HIT = 6;
const MAX_W = 860;
const MIN_ZOOM = 0.1, MAX_ZOOM = 32;
const HISTORY = 40;
const DEFAULT_HELP =
  "Click = row line · Shift-click = column · Shift double-click = 2 cols (33/66) · Shift triple-click = 3 cols (25/50/75) · drag a guide to move · Ctrl-drag = move layer · Shift-drag = multi-select · drag into a gutter to delete · Ctrl+scroll to zoom · Ctrl+Z undo · drop image on tab bar = new doc";

// Open documents (tabs) and transient interaction state.
let docs = [];
let active = -1;
let D = null;       // active document
let drag = null, band = null;
let lastMouse = { x: 0, y: 0 }; // latest cursor (client coords) — anchors the px readout

// Row-nudge px readout visibility: shown while dragging (Infinity) and for a short
// linger after the drag/keyboard nudge ends, then it fades.
const NUDGE_LINGER = 5000;
let nudgeExpire = 0;      // Date.now() ceiling to keep the readout visible
let nudgeHideTimer = null;
function keepNudgeVisible(ms) {
  nudgeExpire = ms === Infinity ? Infinity : Date.now() + ms;
  clearTimeout(nudgeHideTimer);
  if (ms !== Infinity) nudgeHideTimer = setTimeout(() => { nudgeExpire = 0; if (D) drawCanvas(); }, ms);
}

// A doc holds a slice grid (project) shared across one or more image VERSION layers.
// The ACTIVE layer is what exports and what Ctrl+drag moves; every layer with its
// eye on renders (bottom -> top) at its own offset/scale/opacity — images are NEVER
// stretched to the grid, they lie at native size times their transform.
function makeLayer(id, name, imageUrl) {
  return { id, name, imageUrl, image: null, x: 0, y: 0, scale: 1, opacity: 1, visible: true };
}
function makeDoc(project, firstLayer, name) {
  return {
    name, project,
    layers: [firstLayer], activeLayer: 0, nextLayerId: 2,
    magnet: true, // auto-align after Ctrl+drag (pixel-match vs the layer below)
    diff: false, diffCanvas: null,
    baseScale: 1, zoom: 1, scale: 1,
    dpr: 1, cssW: 0, cssH: 0, // device-pixel-ratio + logical canvas size (crisp HiDPI)
    selRow: 0, selRows: new Set(), selCols: new Set(), sel: null, selCell: -1,
    nudgeAnchor: null, // selected row boundary's top when grabbed -> px readout baseline
    history: [], future: [],
  };
}
const vis = () => D.layers[D.activeLayer];

// ---- history (per document) ------------------------------------------------

// Snapshots cover the grid AND each layer's placement, so layer drags and template
// scaling are undoable alongside slice edits.
const snapshot = () => ({
  project: structuredClone(D.project),
  transforms: D.layers.map((l) => ({ id: l.id, x: l.x, y: l.y, scale: l.scale })),
});
function restore(s) {
  D.project = s.project;
  for (const t of s.transforms) {
    const l = D.layers.find((k) => k.id === t.id);
    if (l) { l.x = t.x; l.y = t.y; l.scale = t.scale; }
  }
}
function pushUndo() {
  D.history.push(snapshot());
  if (D.history.length > HISTORY) D.history.shift();
  D.future = [];
}
function undo() {
  if (!D.history.length) return;
  D.future.push(snapshot());
  restore(D.history.pop());
  afterHistoryJump();
}
function redo() {
  if (!D.future.length) return;
  D.history.push(snapshot());
  restore(D.future.pop());
  afterHistoryJump();
}
function afterHistoryJump() {
  clearSelection();
  D.baseScale = Math.min(1, MAX_W / D.project.width); // a scale step may have resized the grid
  applyScale();
  computeDiff();
  render();
}
function clearSelection() {
  D.selRows.clear();
  D.selCols.clear();
  D.sel = null;
  D.selCell = -1;
  D.nudgeAnchor = null;
  D.shiftSel = false; // selection is no longer a shift-built multi-select
}

// Global slice index (grid order) for a row/column, or the column at an (x,y) point.
function cellIndex(ri, ci) {
  let idx = 0;
  for (let r = 0; r < ri; r++) idx += D.project.rows[r].columns.length;
  return idx + ci;
}
function cellAt(p) {
  const ri = rowAt(p.y);
  if (ri < 0) return -1;
  const row = D.project.rows[ri];
  let ci = row.columns.findIndex((c) => p.x >= c.left && p.x < c.right);
  if (ci < 0) ci = row.columns.length - 1;
  return cellIndex(ri, ci);
}
// Alt/Option-click a section on canvas -> select + reveal its slice in the sidebar.
function selectCellAt(p) {
  const idx = cellAt(p);
  if (idx < 0) return;
  D.selCell = idx;
  D.selRow = rowAt(p.y);
  render();
  const line = document.querySelectorAll(".sliceline")[idx];
  if (line) { line.scrollIntoView({ block: "nearest" }); line.querySelector(".surl")?.focus(); }
}

// ---- documents / tabs ------------------------------------------------------

async function openFiles(fileList) {
  setBusy(true);
  try {
    for (const file of fileList) {
      const layer = makeLayer("L1", file.name, URL.createObjectURL(file));
      await loadLayerImage(layer);
      const project = detectProject(layer.image, file.name, currentRules()); // client detect
      docs.push(makeDoc(project, layer, file.name));
    }
    enableUI(true);
    switchTo(docs.length - 1); // unhides + sizes the canvas, renders tabs + view
  } catch (err) {
    alert("Open failed: " + err.message);
  } finally {
    setBusy(false);
  }
}

function loadLayerImage(layer) {
  return loadImg(layer.imageUrl).then((img) => { layer.image = img; });
}

function switchTo(i) {
  if (i < 0 || i >= docs.length) return;
  active = i;
  D = docs[i];
  stage.classList.add("loaded");
  $("empty").hidden = true;
  $("layers").hidden = false;
  canvas.hidden = false;
  D.baseScale = Math.min(1, MAX_W / D.project.width); // grid-canonical fit
  applyScale();
  renderTabs();
  renderLayers();
  refreshEmailPanel();
  render();
}

function closeDoc(i) {
  if (!confirm("Close this tab? Unsaved slice changes will be lost.")) return;
  docs.splice(i, 1);
  if (docs.length === 0) {
    active = -1; D = null;
    canvas.hidden = true;
    $("empty").hidden = false;
    $("tabs").hidden = true;
    $("panel").hidden = true;
    $("layers").hidden = true;
    enableUI(false);
    return;
  }
  switchTo(Math.min(i, docs.length - 1));
}

function renderTabs() {
  const tabs = $("tabs");
  tabs.hidden = docs.length === 0;
  tabs.innerHTML = "";
  docs.forEach((doc, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === active ? " active" : "");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = doc.name;
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    close.onclick = (e) => { e.stopPropagation(); closeDoc(i); };
    el.append(name, close);
    el.onclick = () => switchTo(i);
    tabs.appendChild(el);
  });
}

// ---- layers (image versions, shared slice grid) ----------------------------

// Add a dropped/picked image as a NEW version layer at its NATIVE size (no scaling —
// Ctrl+drag to place it, Scale… to resize the template). Detection is NOT re-run.
async function addLayer(file) {
  if (!D) return;
  setBusy(true);
  try {
    const layer = makeLayer("L" + D.nextLayerId++, file.name, URL.createObjectURL(file));
    await loadLayerImage(layer);
    D.layers.push(layer);
    setActiveLayer(D.layers.length - 1);
  } catch (err) {
    alert("Add layer failed: " + err.message);
  } finally {
    setBusy(false);
  }
}

function setActiveLayer(i) {
  D.activeLayer = i;
  vis().visible = true; // active layer is always shown
  D.project.image = vis().name; // name only (for the .slice); export reads the pixels
  computeDiff(); // base layer changed
  renderLayers();
  render();
}

function deleteLayer(i) {
  if (D.layers.length <= 1) return; // keep at least one
  D.layers.splice(i, 1);
  if (D.activeLayer >= D.layers.length) D.activeLayer = D.layers.length - 1;
  else if (D.activeLayer > i) D.activeLayer--;
  if (D.layers.length < 2) D.diff = false; // nothing to compare
  setActiveLayer(D.activeLayer);
}

function renderLayers() {
  const list = $("layerList");
  list.innerHTML = "";
  // Show top layer first (visual stack order).
  for (let i = D.layers.length - 1; i >= 0; i--) {
    const layer = D.layers[i];
    const el = document.createElement("div");
    el.className = "layer" + (i === D.activeLayer ? " active" : "");
    const eye = document.createElement("span");
    eye.className = "eye" + (layer.visible ? "" : " off");
    eye.textContent = layer.visible ? "👁" : "◡";
    eye.title = layer.visible ? "Hide layer" : "Show layer";
    eye.onclick = (e) => { e.stopPropagation(); layer.visible = !layer.visible; renderLayers(); drawCanvas(); };
    const name = document.createElement("span");
    name.className = "lname";
    name.textContent = layer.name;
    name.title = layer.name + " — click to make active (exported, Ctrl+drag to move)";
    const row2 = document.createElement("div");
    row2.className = "lrow2";
    const op = document.createElement("input");
    op.type = "range"; op.min = 0; op.max = 100; op.value = Math.round((layer.opacity ?? 1) * 100);
    op.className = "lop";
    op.title = "Layer opacity";
    op.onclick = (e) => e.stopPropagation();
    op.oninput = (e) => { e.stopPropagation(); layer.opacity = op.value / 100; drawCanvas(); };
    row2.appendChild(op);
    if ((layer.scale || 1) !== 1) {
      const sc = document.createElement("span");
      sc.className = "lscale";
      sc.textContent = "×" + (Math.round(layer.scale * 100) / 100);
      sc.title = "Layer render scale (from template scaling) — click to reset to native ×1";
      sc.onclick = (e) => {
        e.stopPropagation();
        pushUndo();
        layer.scale = 1;
        computeDiff();
        renderLayers();
        drawCanvas();
      };
      row2.appendChild(sc);
    }
    const del = document.createElement("span");
    del.className = "ldel";
    del.textContent = "✕";
    del.title = "Delete layer";
    del.onclick = (e) => { e.stopPropagation(); if (confirm(`Delete layer "${layer.name}"?`)) deleteLayer(i); };
    const top = document.createElement("div");
    top.className = "lrow1";
    top.append(eye, name, del);
    el.append(top, row2);
    el.onclick = () => setActiveLayer(i);
    list.appendChild(el);
  }
  const dbtn = $("diffToggle");
  dbtn.disabled = D.layers.length < 2;
  dbtn.classList.toggle("active", D.diff && D.layers.length >= 2);
  const mbtn = $("magnetToggle");
  mbtn.disabled = D.layers.length < 2;
  mbtn.classList.toggle("active", D.magnet);
}

// ---- version diff ----------------------------------------------------------

// Layer compared against the active one (the version directly below it in the stack).
function diffBaseIndex() {
  if (D.layers.length < 2) return -1;
  return D.activeLayer > 0 ? D.activeLayer - 1 : D.activeLayer + 1;
}

function toggleDiff() {
  if (!D || D.layers.length < 2) return;
  D.diff = !D.diff;
  computeDiff();
  renderLayers();
  render();
}

// Build a magenta overlay marking pixels that changed between the active layer and
// the version below it. Each is rendered onto a grid-size canvas with its own
// offset/scale, so the comparison honours layer placement. Areas either layer
// doesn't cover are skipped (a smaller module over a template isn't all "changed").
function computeDiff() {
  D.diffCanvas = null;
  if (!D || !D.diff) return;
  const bi = diffBaseIndex();
  if (bi < 0) return;
  const a = vis(), b = D.layers[bi];
  if (!a.image || !b.image) return;
  const w = D.project.width, h = D.project.height;
  const da = layerData(a, w, h), db = layerData(b, w, h);
  const out = new ImageData(w, h);
  const TH = 40; // sum-of-abs RGB change to count as "changed"
  for (let i = 0; i < da.length; i += 4) {
    if (da[i + 3] < 200 || db[i + 3] < 200) continue; // uncovered by one layer
    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    if (d > TH) { out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 255; out.data[i + 3] = 160; }
  }
  const oc = document.createElement("canvas");
  oc.width = w; oc.height = h;
  oc.getContext("2d").putImageData(out, 0, 0);
  D.diffCanvas = oc;
}

// Pixels of a layer as placed on the grid (offset + scale applied, native pixels).
function layerData(layer, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(layer.image, layer.x, layer.y,
    layer.image.naturalWidth * (layer.scale || 1), layer.image.naturalHeight * (layer.scale || 1));
  return cx.getImageData(0, 0, w, h).data;
}

// Nudge the active layer to the offset (within ±radius px) that best pixel-matches
// the layer below it — makes Ctrl+drag placement pixel perfect. Sparse-sampled so
// it stays fast on tall creatives.
function autoAlign(radius = 8) {
  const bi = diffBaseIndex();
  if (bi < 0) return false;
  const l = vis(), base = D.layers[bi];
  if (!l.image || !base.image) return false;
  const ls = l.scale || 1;
  const lw = Math.round(l.image.naturalWidth * ls), lh = Math.round(l.image.naturalHeight * ls);
  const gw = D.project.width, gh = D.project.height;
  const bd = layerData(base, gw, gh);
  // Active layer rendered origin-local at its own scale (offset applied per candidate).
  const c = document.createElement("canvas");
  c.width = lw; c.height = lh;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(l.image, 0, 0, lw, lh);
  const ad = cx.getImageData(0, 0, lw, lh).data;
  // Cap total samples (~20k) so the search is O(candidates × 20k), not image-sized.
  const STEP = Math.max(2, Math.ceil(Math.sqrt((lw * lh) / 20000)));
  const x0 = Math.round(l.x), y0 = Math.round(l.y);
  let best = { dx: 0, dy: 0, cost: Infinity };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const ox = x0 + dx, oy = y0 + dy;
      let cost = 0, n = 0;
      for (let py = 0; py < lh; py += STEP) {
        const gy = py + oy;
        if (gy < 0 || gy >= gh) continue;
        const arow = py * lw, brow = gy * gw;
        for (let px = 0; px < lw; px += STEP) {
          const gx = px + ox;
          if (gx < 0 || gx >= gw) continue;
          const ai = (arow + px) * 4, bi2 = (brow + gx) * 4;
          if (ad[ai + 3] < 200 || bd[bi2 + 3] < 200) continue;
          cost += Math.abs(ad[ai] - bd[bi2]) + Math.abs(ad[ai + 1] - bd[bi2 + 1]) + Math.abs(ad[ai + 2] - bd[bi2 + 2]);
          n++;
        }
      }
      if (n > 50) {
        const avg = cost / n;
        if (avg < best.cost) best = { dx, dy, cost: avg };
      }
    }
  }
  if (best.cost === Infinity || (!best.dx && !best.dy)) return false;
  l.x = x0 + best.dx;
  l.y = y0 + best.dy;
  return true;
}

// Replace the ACTIVE layer's image (top-left anchored re-fit of the shared grid).
async function replaceImage(file) {
  if (!D) return;
  setBusy(true);
  try {
    pushUndo();
    vis().imageUrl = URL.createObjectURL(file);
    vis().name = file.name;
    vis().x = 0; vis().y = 0; vis().scale = 1; // fresh image lies at native size, origin
    await loadLayerImage(vis());
    E.clampToSize(D.project, vis().image.naturalWidth, vis().image.naturalHeight); // adapt grid, top-left
    D.project.image = file.name;
    D.baseScale = Math.min(1, MAX_W / D.project.width);
    applyScale();
    clearSelection();
    renderTabs();
    renderLayers();
    render();
  } catch (err) {
    D.history.pop();
    alert("Replace failed: " + err.message);
  } finally {
    setBusy(false);
  }
}

const MAX_CANVAS_PX = 16384; // browser canvas dimension limit; allows ~5x on tall creatives

// Zoom limits and canvas size derive from the grid-canonical project dimensions,
// so every version layer renders at the same scale and the grid always aligns.
function maxZoomFor() {
  const fit = D.baseScale;
  // The backing store is DPR-scaled, so the 16384 limit is hit sooner on HiDPI.
  const dpr = window.devicePixelRatio || 1;
  return Math.min(MAX_ZOOM, MAX_CANVAS_PX / (D.project.width * fit * dpr), MAX_CANVAS_PX / (D.project.height * fit * dpr));
}

function applyScale() {
  D.zoom = Math.max(MIN_ZOOM, Math.min(maxZoomFor(), D.zoom));
  D.scale = D.baseScale * D.zoom;
  D.dpr = window.devicePixelRatio || 1;
  D.cssW = Math.round(D.project.width * D.scale);
  D.cssH = Math.round(D.project.height * D.scale);
  // Backing store at device resolution -> crisp text/lines/image under OS display
  // scaling & HiDPI (Photopea-style). CSS size stays logical so layout is unchanged.
  canvas.width = Math.round(D.cssW * D.dpr);
  canvas.height = Math.round(D.cssH * D.dpr);
  canvas.style.width = D.cssW + "px";
  canvas.style.height = D.cssH + "px";
}

// ---- zoom (mouse-anchored, rAF-throttled) ----------------------------------

let zoomRaf = null;
let zoomAnchor = null; // { imgX, imgY, clientX, clientY } captured at cursor

stage.addEventListener("wheel", (ev) => {
  if (!D || !(ev.ctrlKey || ev.shiftKey || ev.metaKey)) return;
  ev.preventDefault();
  // Capture the image point currently under the cursor (using the live scale).
  const p = toImage(ev);
  zoomAnchor = { imgX: p.x, imgY: p.y, clientX: ev.clientX, clientY: ev.clientY };
  // Accumulate the zoom factor; coalesce bursts of wheel events into one frame.
  const factor = Math.exp(-ev.deltaY * 0.0015);
  D.zoom = Math.max(MIN_ZOOM, Math.min(maxZoomFor(), D.zoom * factor));
  if (!zoomRaf) zoomRaf = requestAnimationFrame(applyZoom);
}, { passive: false });

function applyZoom() {
  zoomRaf = null;
  applyScale();
  render();
  // Re-anchor: shift scroll so the captured image point sits back under the cursor.
  // Reading the post-layout rect makes this robust to centering/overflow changes.
  const rect = canvas.getBoundingClientRect();
  const a = zoomAnchor;
  stage.scrollLeft += rect.left + a.imgX * D.scale - a.clientX;
  stage.scrollTop += rect.top + a.imgY * D.scale - a.clientY;
}

function scrollToRow(ri) {
  const row = D.project.rows[ri];
  const cy = ((row.top + row.bottom) / 2) * D.scale;
  const rect = canvas.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  stage.scrollTop += rect.top + cy - (sr.top + stage.clientHeight / 2);
}

// ---- rendering -------------------------------------------------------------

// Full update = redraw canvas + rebuild the side panel. Use drawCanvas() alone when
// the panel must NOT be rebuilt (e.g. while a slice name is being edited in it).
function render() {
  drawCanvas();
  refreshPanel();
}

function drawCanvas() {
  if (!D || !vis().image) return;
  const { project, scale, cssW: W, cssH: H } = D;
  // Draw in logical (CSS) px; the DPR transform maps onto the hi-res backing store.
  ctx.setTransform(D.dpr, 0, 0, D.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // Composite every visible layer bottom -> top at its own offset/scale/opacity.
  // Images are never stretched to the grid — native size × layer scale × view scale.
  for (const l of D.layers) {
    if (!l.visible || !l.image) continue;
    ctx.globalAlpha = l.opacity ?? 1;
    ctx.drawImage(l.image, l.x * scale, l.y * scale,
      l.image.naturalWidth * (l.scale || 1) * scale, l.image.naturalHeight * (l.scale || 1) * scale);
  }
  ctx.globalAlpha = 1;
  if (D.diff && D.diffCanvas) ctx.drawImage(D.diffCanvas, 0, 0, W, H);
  // Dashed outline of the active layer while it's being Ctrl+dragged.
  if (drag && drag.layerMove) {
    const l = vis();
    ctx.strokeStyle = "#4f9dff";
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(l.x * scale + 0.5, l.y * scale + 0.5,
      l.image.naturalWidth * (l.scale || 1) * scale, l.image.naturalHeight * (l.scale || 1) * scale);
    ctx.setLineDash([]);
  }

  // Fade slices excluded from the HTML build.
  ctx.fillStyle = "rgba(20,23,28,0.62)";
  for (const row of project.rows) {
    for (const col of row.columns) {
      if (col.include === false) {
        ctx.fillRect(col.left * scale, row.top * scale, (col.right - col.left) * scale, (row.bottom - row.top) * scale);
      }
    }
  }

  project.rows.forEach((row, ri) => {
    const selected = ri === D.selRow;
    // Vertical (column) guides: hot pink; orange when in the rubber-band selection.
    for (let j = 1; j < row.columns.length; j++) {
      const x = row.columns[j].left * scale;
      const picked = D.selCols.has(ri + ":" + j);
      const color = picked ? "#ff9e3d" : selected ? "#ff5cb0" : "#ff2d95";
      line(x, row.top * scale, x, row.bottom * scale, color, picked ? 3.5 : selected ? 3.5 : 2.5);
    }
    if (selected) {
      ctx.fillStyle = "rgba(79,157,255,0.16)";
      ctx.fillRect(0, row.top * scale, W, (row.bottom - row.top) * scale);
    }
  });

  for (let i = 1; i < project.rows.length; i++) {
    const y = project.rows[i].top * scale;
    const inSel = D.selRows.has(i);
    line(0, y, W, y, inSel ? "#ff9e3d" : "#4f9dff", inSel ? 3 : 1.5);
  }

  if (D.sel) highlightSel();
  if (band) drawBand();
  drawCornerLabels();
  drawNudgeLabel();

  const help = $("help");
  if (drag && drag.remove) {
    ctx.fillStyle = "rgba(255,107,107,0.12)";
    ctx.fillRect(0, 0, W, H);
    const n = drag.group ? D.selRows.size : 1;
    help.textContent = `Release in the gutter to delete ${n > 1 ? n + " guides" : "this guide"}`;
    help.style.color = "var(--danger)";
  } else {
    help.textContent = DEFAULT_HELP;
    help.style.color = "";
  }
}

function line(x1, y1, x2, y2, color, w) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x1 + 0.5, y1 + 0.5);
  ctx.lineTo(x2 + 0.5, y2 + 0.5);
  ctx.stroke();
}

// Tiny per-slice name labels in each cell's corner. Drawn in logical px under the
// DPR transform, so they stay crisp at a constant on-screen size at any zoom.
function drawCornerLabels() {
  const { project, scale } = D;
  ctx.save();
  ctx.font = "13px system-ui, sans-serif";
  ctx.textBaseline = "top";
  let n = 0;
  project.rows.forEach((row, ri) => {
    row.columns.forEach((col, ci) => {
      const idx = n++;
      const label = (col.name && col.name.trim()) || defaultSliceName(ri, ci, row.columns.length);
      const x = col.left * scale + 3;
      const y = row.top * scale + 3;
      const w = ctx.measureText(label).width;
      const sel = idx === D.selCell;
      ctx.fillStyle = sel ? "rgba(255,204,85,0.95)" : "rgba(15,19,24,0.7)";
      ctx.fillRect(x - 2, y - 2, w + 6, 18);
      ctx.fillStyle = sel ? "#1a1400" : "#e6e9ef";
      ctx.fillText(label, x + 1, y);
    });
  });
  // Outline the alt-clicked cell.
  if (D.selCell >= 0) {
    let k = 0, done = false;
    for (const row of project.rows) {
      for (const col of row.columns) {
        if (k++ === D.selCell) {
          ctx.strokeStyle = "#ffcc55"; ctx.lineWidth = 2;
          ctx.strokeRect(col.left * scale + 1, row.top * scale + 1, (col.right - col.left) * scale - 2, (row.bottom - row.top) * scale - 2);
          done = true; break;
        }
      }
      if (done) break;
    }
  }
  ctx.restore();
}

// px readout for the selected row boundary: how far it has moved since it was
// grabbed. Shown only while dragging + a short linger after (see keepNudgeVisible),
// positioned beside the cursor on the side facing the canvas middle — so it stays
// on-screen even when zoomed in off-centre. Nudge with drag or ↑/↓ (2 px, Shift 20).
function drawNudgeLabel() {
  if (!D.sel || D.sel.axis !== "row" || D.nudgeAnchor == null) return;
  if (Date.now() >= nudgeExpire) return;
  const row = D.project.rows[D.sel.i];
  if (!row) return;
  const delta = Math.round(row.top - D.nudgeAnchor);
  const text = (delta > 0 ? "+" : delta < 0 ? "−" : "") + Math.abs(delta) + " px";
  const rect = canvas.getBoundingClientRect();
  const mx = lastMouse.x - rect.left, my = lastMouse.y - rect.top;
  ctx.save();
  ctx.font = "13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const padX = 7, h = 20, gap = 14;
  const w = ctx.measureText(text).width + padX * 2;
  // Cursor left of centre -> label to its right (toward middle), and vice-versa.
  let bx = mx < D.cssW / 2 ? mx + gap : mx - gap - w;
  let by = my - h / 2;
  bx = Math.max(2, Math.min(D.cssW - w - 2, bx));
  by = Math.max(2, Math.min(D.cssH - h - 2, by));
  ctx.beginPath();
  ctx.roundRect(Math.round(bx), Math.round(by), w, h, 5);
  ctx.fillStyle = "#ff6b6b"; // matches the selected-boundary line colour
  ctx.fill();
  ctx.fillStyle = "#2a0a0a";
  ctx.fillText(text, Math.round(bx) + padX, Math.round(by + h / 2) + 0.5);
  ctx.restore();
}

function highlightSel() {
  const { project, scale, sel } = D;
  if (sel.axis === "row") {
    const y = project.rows[sel.i].top * scale;
    line(0, y, D.cssW, y, "#ff6b6b", 3);
  } else {
    const row = project.rows[sel.ri];
    const x = row.columns[sel.j].left * scale;
    line(x, row.top * scale, x, row.bottom * scale, "#ff6b6b", 3.5);
  }
}

function drawBand() {
  const scale = D.scale;
  const y0 = Math.min(band.y0, band.y1) * scale;
  const y1 = Math.max(band.y0, band.y1) * scale;
  ctx.fillStyle = "rgba(255,158,61,0.12)";
  ctx.fillRect(0, y0, D.cssW, y1 - y0);
  ctx.strokeStyle = "#ff9e3d";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(0.5, y0 + 0.5, D.cssW - 1, y1 - y0 - 1);
  ctx.setLineDash([]);
}

// ---- hit testing -----------------------------------------------------------

function toImage(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / D.scale, y: (ev.clientY - r.top) / D.scale };
}
function hitRowBoundary(p) {
  const tol = HIT / D.scale;
  for (let i = 1; i < D.project.rows.length; i++) {
    if (Math.abs(p.y - D.project.rows[i].top) <= tol) return i;
  }
  return -1;
}
function hitColBoundary(p) {
  const tol = HIT / D.scale;
  const { rows } = D.project;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (p.y < row.top || p.y > row.bottom) continue;
    for (let j = 1; j < row.columns.length; j++) {
      if (Math.abs(p.x - row.columns[j].left) <= tol) return { ri, j };
    }
  }
  return null;
}
function rowAt(y) {
  return D.project.rows.findIndex((r) => y >= r.top && y < r.bottom);
}

// ---- interaction -----------------------------------------------------------
// Click = add row line. Shift-click = add column line. Shift double-click = 2 cols
// (33/66). Shift triple-click = 3 cols (25/50/75). Drag a guide to move. Shift-drag =
// multi-select. Drag a guide into a gutter to delete.

const MOVE_THRESH = 4; // screen px before a press counts as a drag, not a click
let press = null;      // pending empty-space click: { x, y, sx, sy, shift, moved }
let shiftClick = { count: 0, x: 0, y: 0, timer: null };

canvas.addEventListener("mousedown", (ev) => {
  if (!D) return;
  const p = toImage(ev);
  if (ev.altKey) { selectCellAt(p); return; } // Alt/Option-click = select the section
  if ((ev.ctrlKey || ev.metaKey) && vis().image) { // Ctrl+drag = move the active layer
    ev.preventDefault();
    drag = { layerMove: true, startX: p.x, startY: p.y, origX: vis().x, origY: vis().y, pushed: false };
    canvas.style.cursor = "grabbing";
    return;
  }
  const ri = hitRowBoundary(p);
  if (ri !== -1 && ev.shiftKey) { // shift-click a row guide -> toggle multi-select
    D.selRows.has(ri) ? D.selRows.delete(ri) : D.selRows.add(ri);
    D.sel = null; D.shiftSel = true; render(); return;
  }
  if (ri !== -1) { // grab a row guide -> move (group if it's in a multi-selection)
    const group = D.selRows.has(ri) && D.selRows.size > 1;
    if (!group) { D.selRows.clear(); D.selRows.add(ri); D.shiftSel = false; } // fresh single (plain) selection
    pushUndo();
    const snap = new Map();
    for (const k of D.selRows) snap.set(k, D.project.rows[k].top);
    drag = { axis: "row", i: ri, group, snap, startY: p.y };
    D.sel = { axis: "row", i: ri };
    D.nudgeAnchor = group ? null : D.project.rows[ri].top; // baseline for the px readout
    render();
    return;
  }
  const col = hitColBoundary(p);
  if (col && !ev.shiftKey) { // grab a column guide -> move (group if in a multi-selection)
    const group = D.selCols.has(col.ri + ":" + col.j) && (D.selCols.size + D.selRows.size > 1);
    if (!group) D.shiftSel = false; // plain single-column grab
    pushUndo();
    drag = { axis: "col", ...col, group };
    D.sel = { axis: "col", ...col };
    render();
    return;
  }
  // empty space (or shift over a column line): decide click vs drag/band on move/up
  press = { x: p.x, y: p.y, sx: ev.clientX, sy: ev.clientY, shift: ev.shiftKey, moved: false };
});

// Snap a layer edge (leading or trailing, per axis) onto the nearest grid line
// within tolerance. Grid lines = canvas edges + every row/column boundary.
function snapAxis(pos, size, lines, tol) {
  let best = pos, bestErr = tol;
  for (const g of lines) {
    for (const edge of [g, g - size]) { // layer start lands on g, or layer end lands on g
      const err = Math.abs(pos - edge);
      if (err < bestErr) { bestErr = err; best = edge; }
    }
  }
  return best;
}
function snapLayerPos(nx, ny, l) {
  const tol = 8 / D.scale; // constant screen-px feel at any zoom
  const w = l.image.naturalWidth * (l.scale || 1);
  const h = l.image.naturalHeight * (l.scale || 1);
  const xs = new Set([0, D.project.width]);
  const ys = new Set([0, D.project.height]);
  for (const r of D.project.rows) {
    ys.add(r.top); ys.add(r.bottom);
    for (let j = 1; j < r.columns.length; j++) xs.add(r.columns[j].left);
  }
  return { x: snapAxis(nx, w, xs, tol), y: snapAxis(ny, h, ys, tol) };
}

window.addEventListener("mousemove", (ev) => {
  if (!D) return;
  lastMouse.x = ev.clientX; lastMouse.y = ev.clientY;
  if (drag) {
    const p = toImage(ev);
    if (drag.layerMove) {
      if (!drag.pushed) { pushUndo(); drag.pushed = true; }
      const l = vis();
      const s = snapLayerPos(drag.origX + (p.x - drag.startX), drag.origY + (p.y - drag.startY), l);
      l.x = Math.round(s.x);
      l.y = Math.round(s.y);
      drawCanvas();
      return;
    }
    const { width, height } = D.project;
    const off = p.x < 0 || p.x > width || p.y < 0 || p.y > height;
    drag.remove = off;
    if (!off) {
      // A grouped column drag only exists to delete (drag to gutter) — don't shift a
      // single column of the group while dragging toward it.
      if (drag.axis === "col") { if (!drag.group) E.moveColBoundary(D.project, drag.ri, drag.j, p.x); }
      else if (drag.group) E.moveRowGroup(D.project, D.selRows, drag.snap, p.y - drag.startY);
      else {
        // Snap to even 2px offsets from where it was grabbed (even-only readout, as a test).
        const anchor = D.nudgeAnchor ?? p.y;
        E.moveRowBoundary(D.project, drag.i, anchor + Math.round((p.y - anchor) / 2) * 2);
        drag.moved = true;
        keepNudgeVisible(Infinity);
      }
    }
    render();
    return;
  }
  if (band) { band.y1 = toImage(ev).y; render(); return; }
  if (press) {
    if (Math.hypot(ev.clientX - press.sx, ev.clientY - press.sy) > MOVE_THRESH) {
      if (press.shift) {
        // A fresh band drops any prior PLAIN selection; shift-built selections accumulate.
        if (!D.shiftSel) clearSelection();
        band = { y0: press.y, y1: toImage(ev).y }; press = null; render();
      }
      else press = null; // plain drag on empty space does nothing
    }
    return;
  }
  updateCursor(ev);
});

window.addEventListener("mouseup", () => {
  if (!D) return;
  if (drag) {
    const d = drag; drag = null;
    if (d.layerMove) {
      canvas.style.cursor = "";
      // Magnet: refine to the best pixel match vs the layer below (skips if it
      // didn't actually move / never pushed undo — nothing to align from).
      if (d.pushed && D.magnet) autoAlign();
      computeDiff(); // placement changed -> diff overlay is stale
      drawCanvas();
      return;
    }
    if (d.remove) {
      if (d.group) E.removeSelection(D.project, D.selRows, D.selCols); // whole multi-select (rows and/or cols)
      else if (d.axis === "col") E.removeColBoundary(D.project, d.ri, d.j);
      else E.removeRowBoundary(D.project, d.i);
      clearSelection();
    } else if (d.axis === "row" && !d.group && d.moved) {
      keepNudgeVisible(NUDGE_LINGER); // linger after releasing a row nudge-drag
    }
    render();
    return;
  }
  if (band) {
    const a = Math.min(band.y0, band.y1), b = Math.max(band.y0, band.y1);
    const rows = D.project.rows;
    for (let ri = 0; ri < rows.length; ri++) {
      if (ri >= 1 && rows[ri].top >= a && rows[ri].top <= b) D.selRows.add(ri);
      const mid = (rows[ri].top + rows[ri].bottom) / 2;
      if (mid >= a && mid <= b) for (let j = 1; j < rows[ri].columns.length; j++) D.selCols.add(ri + ":" + j);
    }
    band = null; D.shiftSel = true; render();
    return;
  }
  if (press && !press.moved) {
    const { x, y, shift } = press; press = null;
    if (shift) registerShiftClick(x, y);           // count for 1/2/3 column preset
    else { pushUndo(); E.addRowBoundary(D.project, y); clearSelection(); render(); } // add a row
    return;
  }
  press = null;
});

// Shift-clicks are debounced so 1/2/3 clicks map to 1 col / 33-66 / 25-50-75.
function registerShiftClick(x, y) {
  if (shiftClick.count === 0) { shiftClick.x = x; shiftClick.y = y; }
  shiftClick.count++;
  clearTimeout(shiftClick.timer);
  shiftClick.timer = setTimeout(applyShiftClicks, 280);
}
function applyShiftClicks() {
  const { count, x, y } = shiftClick;
  shiftClick.count = 0;
  const ri = rowAt(y);
  if (ri === -1) return;
  const w = D.project.width;
  pushUndo();
  if (count === 1) {
    // Single click: additive while the row has at most one cut, but once it's in a
    // multi-slice (preset) state a single click REPLACES it with just this one cut.
    if (D.project.rows[ri].columns.length > 2) E.clearColumns(D.project, ri);
    E.addColBoundary(D.project, ri, x);
  } else {
    // Presets REPLACE the row's columns (clear first) so a mis-slice is fixed by
    // re-clicking, not by dragging pieces away.
    E.clearColumns(D.project, ri);
    if (count === 2) { E.addColBoundary(D.project, ri, w / 3); E.addColBoundary(D.project, ri, (2 * w) / 3); }
    else { E.addColBoundary(D.project, ri, w / 4); E.addColBoundary(D.project, ri, w / 2); E.addColBoundary(D.project, ri, (3 * w) / 4); }
  }
  clearSelection();
  render();
}

function updateCursor(ev) {
  if (ev.ctrlKey || ev.metaKey) { canvas.style.cursor = "grab"; return; } // layer move
  const p = toImage(ev);
  if (hitRowBoundary(p) !== -1) canvas.style.cursor = "ns-resize";
  else if (hitColBoundary(p)) canvas.style.cursor = "ew-resize";
  else canvas.style.cursor = "crosshair";
}

window.addEventListener("keydown", (ev) => {
  if (!D) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.isContentEditable)) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && (ev.key === "z" || ev.key === "Z")) { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && (ev.key === "y" || ev.key === "Y")) { ev.preventDefault(); redo(); return; }

  const step = ev.shiftKey ? 20 : 2; // rows nudge 2 px (Shift = 20); a px off doesn't matter
  if (ev.key === "Delete" || ev.key === "Backspace") {
    if (D.selRows.size > 0 || D.selCols.size > 0) {
      ev.preventDefault(); pushUndo();
      E.removeSelection(D.project, D.selRows, D.selCols); clearSelection(); render();
    } else if (D.sel) {
      ev.preventDefault(); pushUndo();
      if (D.sel.axis === "row") E.removeRowBoundary(D.project, D.sel.i);
      else E.removeColBoundary(D.project, D.sel.ri, D.sel.j);
      D.sel = null; render();
    }
  } else if (D.sel && (ev.key === "ArrowUp" || ev.key === "ArrowDown") && D.sel.axis === "row") {
    ev.preventDefault(); pushUndo();
    const cur = D.project.rows[D.sel.i].top;
    E.moveRowBoundary(D.project, D.sel.i, cur + (ev.key === "ArrowDown" ? step : -step));
    keepNudgeVisible(NUDGE_LINGER); render();
  } else if (D.sel && (ev.key === "ArrowLeft" || ev.key === "ArrowRight") && D.sel.axis === "col") {
    ev.preventDefault(); pushUndo();
    const row = D.project.rows[D.sel.ri];
    const cur = row.columns[D.sel.j].left;
    E.moveColBoundary(D.project, D.sel.ri, D.sel.j, cur + (ev.key === "ArrowRight" ? step : -step)); render();
  }
});

// ---- panel + toolbar -------------------------------------------------------

// Default slice name from its position (must match core/exporter defaultSliceName):
// padded row number, with a -N column suffix only when the row has >1 column.
function defaultSliceName(ri, ci, colCount) {
  const rowNum = String(ri + 1).padStart(3, "0");
  return colCount > 1 ? `${rowNum}-${ci + 1}` : rowNum;
}

function refreshPanel() {
  const { project } = D;
  $("panel").hidden = false;
  const cells = project.rows.reduce((n, r) => n + r.columns.length, 0);
  const z = Math.round(D.zoom * 100);
  const selCount = D.selRows.size + D.selCols.size;
  const selNote = selCount ? ` · ${selCount} selected` : "";
  $("stats").textContent = `${project.rows.length} rows · ${cells} cells · ${project.width}×${project.height} · ${z}%${selNote}`;
  const list = $("rowList");
  // Never rebuild the list while a slice name is being edited — that would destroy
  // the focused field mid-keystroke. Stats above still update.
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains("sname") && list.contains(ae)) return;
  list.innerHTML = "";
  // One line per slice; the label is the slice name, click to edit as plain text.
  let n = 0;
  project.rows.forEach((row, ri) => {
    row.columns.forEach((c, ci) => {
      list.appendChild(makeSliceLine(c, ri, defaultSliceName(ri, ci, row.columns.length), n++));
    });
  });
}

// Reverse of alt-click: clicking (or focusing) anything on a slice's sidebar line
// selects that slice on the canvas (yellow border + row tint) and scrolls to it.
function jumpToSlice(index, ri) {
  D.selCell = index;
  D.selRow = ri;
  drawCanvas();
  scrollToRow(ri);
  document.querySelectorAll("#rowList .sliceline").forEach((el) => {
    el.classList.toggle("picked", Number(el.dataset.index) === index);
    el.classList.toggle("sel", Number(el.dataset.ri) === ri);
  });
}

function makeSliceLine(column, ri, auto, index) {
  const li = document.createElement("li");
  const off = column.include === false;
  li.className = "sliceline" + (ri === D.selRow ? " sel" : "") + (off ? " off" : "") + (index === D.selCell ? " picked" : "");
  li.dataset.index = index;
  li.dataset.ri = ri;

  // Include-in-build toggle (replaces the old name indicator). Off -> faded everywhere.
  const tog = document.createElement("button");
  tog.className = "sinc" + (off ? "" : " on");
  tog.textContent = off ? "○" : "◉";
  tog.title = off ? "Off — excluded from HTML build" : "On — included in HTML build";
  tog.onclick = (e) => {
    e.stopPropagation();
    D.selCell = index; D.selRow = ri; scrollToRow(ri); // highlight + jump to this slice
    pushUndo();
    column.include = off ? true : false; // toggle
    render();
  };

  // Tiny per-slice OCR button (re-transcribe just this slice, no warning).
  const ocrB = document.createElement("button");
  ocrB.className = "sliceocr";
  ocrB.textContent = "OCR";
  ocrB.title = "Re-transcribe this slice";
  ocrB.onclick = (e) => { e.stopPropagation(); jumpToSlice(index, ri); ocrOne(index); };

  const nameEl = bindEditable("sname", column.name, auto, ri, (v) => { column.name = v || null; });
  const altEl = bindEditable("salt", column.alt, "alt text…", ri, (v) => { column.alt = v || null; });
  const urlEl = bindEditable("surl", column.link, "url…", ri, (v) => { column.link = v || null; });

  li.append(tog, ocrB, nameEl, altEl, urlEl);
  // Any click / field-focus on the line jumps the canvas to this slice.
  li.addEventListener("click", () => jumpToSlice(index, ri));
  li.addEventListener("focusin", () => jumpToSlice(index, ri));
  return li;
}

// A contenteditable field that commits to `set(value)` on blur. Selecting/jumping to
// the slice is handled by the parent line's focusin (jumpToSlice), so a rebuild can't
// kill the focused field here.
function bindEditable(cls, initial, placeholder, ri, set) {
  const el = document.createElement("span");
  el.className = cls;
  el.contentEditable = "true";
  el.spellcheck = false;
  el.textContent = initial || "";
  el.dataset.placeholder = placeholder;
  let pushed = false;
  el.addEventListener("focus", () => { pushed = false; });
  el.addEventListener("input", () => { if (!pushed) { pushUndo(); pushed = true; } });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); el.textContent = initial || ""; el.blur(); }
  });
  el.addEventListener("blur", () => set(el.textContent.trim()));
  return el;
}

function currentRules() {
  return { threshold: Number($("threshold").value) };
}

async function autodetect() {
  if (!D) return;
  setBusy(true);
  try {
    pushUndo();
    D.project = redetectProject(vis().image, D.project, currentRules()); // client re-detect
    D.selRow = Math.min(D.selRow, D.project.rows.length - 1);
    clearSelection();
    render();
  } catch (err) {
    D.history.pop();
    alert("Re-detect failed: " + err.message);
  } finally {
    setBusy(false);
  }
}

// Scale the whole template by a factor: grid coordinates, canvas size, AND every
// layer's placement (offset ×k, render scale ×k) so everything stays aligned.
// Workflow: pre-slice on a 1x comp, Scale ×2, drop the true 2x art in as a layer.
function applyTemplateScale(k) {
  if (!D || !isFinite(k) || k <= 0 || k === 1) return;
  pushUndo();
  E.scaleProject(D.project, k);
  for (const l of D.layers) { l.x = Math.round(l.x * k); l.y = Math.round(l.y * k); l.scale = (l.scale || 1) * k; }
  D.baseScale = Math.min(1, MAX_W / D.project.width);
  applyScale();
  computeDiff();
  clearSelection();
  renderLayers(); // scale badges
  render();
}

// ---- Scale modal (slider snaps to .25 steps, 0.25-3.00) --------------------

const SCALE_MIN = 0.25, SCALE_MAX = 3;

function openScaleModal() {
  if (!D) return;
  $("scaleSlider").value = 2;
  updateScaleUI(2);
  $("scaleModal").hidden = false;
}
function closeScaleModal() { $("scaleModal").hidden = true; }
function updateScaleUI(k) {
  $("scaleValue").textContent = k.toFixed(2) + "×";
  document.querySelectorAll(".scalepresets .btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.scale) === k);
  });
}
$("scaleSlider").addEventListener("input", () => {
  const k = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number($("scaleSlider").value)));
  updateScaleUI(k);
});
document.querySelectorAll(".scalepresets .btn").forEach((b) => {
  b.addEventListener("click", () => {
    const k = Number(b.dataset.scale);
    $("scaleSlider").value = k;
    updateScaleUI(k);
  });
});
$("scaleApply").addEventListener("click", () => {
  applyTemplateScale(Number($("scaleSlider").value));
  closeScaleModal();
});
$("scaleCancel").addEventListener("click", closeScaleModal);
$("scaleClose").addEventListener("click", closeScaleModal);
$("scaleModal").addEventListener("mousedown", (e) => { if (e.target === $("scaleModal")) closeScaleModal(); });

let exportDir = null; // remembered folder handle for the session

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Export folder name derived from the initial file added (not the hashed upload).
function exportName() {
  const stem = (D.name || "project").replace(/\.[^.]+$/, "");
  return stem.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 80) || "project";
}

async function ensurePermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

async function doExport(repick) {
  if (!D) return;
  setBusy(true); showSpin("Slicing…");
  try {
    const slices = await exportSlices(D.project, D.layers); // flatten visible layers (opacity/blend) -> [{name,bytes}]
    const projectJson = JSON.stringify(D.project, null, 2);
    const altTxt = buildAltTxt(D.project);
    const folder = exportName();

    // Local mode: browser folder picker, write/overwrite directly to disk.
    if (IS_LOCAL && window.showDirectoryPicker) {
      if (repick || !exportDir) exportDir = await window.showDirectoryPicker({ mode: "readwrite" });
      if (!(await ensurePermission(exportDir))) throw new Error("Folder permission denied");
      showSpin("Writing files…");

      const sub = await exportDir.getDirectoryHandle(folder, { create: true });
      const slicesDir = await sub.getDirectoryHandle("slices", { create: true });
      for (const s of slices) {
        const w = await (await slicesDir.getFileHandle(s.name, { create: true })).createWritable();
        await w.write(s.bytes); await w.close();
      }
      const pw = await (await sub.getFileHandle("project.json", { create: true })).createWritable();
      await pw.write(projectJson); await pw.close();
      if (altTxt) { const aw = await (await sub.getFileHandle("alt.txt", { create: true })).createWritable(); await aw.write(altTxt); await aw.close(); }

      $("exportResult").innerHTML =
        `<strong>Saved ${slices.length} slices</strong><br>to <code>${exportDir.name}/${folder}/</code><br><span class="hint">Shift-click Export to pick a different folder.</span>`;
    } else {
      // Hosted mode (or no disk access): zip every slice + project.json + alt.txt, download.
      showSpin("Zipping slices…");
      const files = slices.map((s) => ({ name: `${folder}/slices/${s.name}`, data: s.bytes }));
      files.push({ name: `${folder}/project.json`, data: new TextEncoder().encode(projectJson) });
      if (altTxt) files.push({ name: `${folder}/alt.txt`, data: new TextEncoder().encode(altTxt) });
      downloadBlob(makeZip(files), `${folder}.zip`, "application/zip");
      $("exportResult").innerHTML = `<strong>Downloaded ${slices.length} slices</strong><br><code>${folder}.zip</code>`;
    }
  } catch (err) {
    if (err.name !== "AbortError") alert("Export failed: " + err.message);
  } finally {
    setBusy(false); hideSpin();
  }
}

function downloadBlob(bytes, filename, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- OCR alt text ----------------------------------------------------------

// Read provider config from the LIVE inputs (so a dropdown change takes effect without
// clicking Save) and persist it.
function currentAICfg() {
  const c = aiCfgFromInputs();
  localStorage.setItem("slaicer.ai", JSON.stringify(c));
  return c;
}
function ocrPrompt() { const p = $("aiPrompt").value.trim(); return p || DEFAULT_OCR_PROMPT; }
function validateAICfg(c) {
  const mode = c.mode || "local";
  if (mode === "local" && (!c.baseUrl || !c.model)) { alert("Local: set the endpoint, Connect, and pick a model."); return false; }
  if (mode === "openai" && (!c.key || !c.model)) { alert("OpenAI: paste your API key, Connect, and pick a model."); return false; }
  if (mode === "anthropic" && !c.key) { alert("Claude: paste your API key."); return false; }
  if (mode === "google" && !c.key) { alert("Google Vision: paste a Cloud API key."); return false; }
  return true;
}

// Footer status (VS Code style — single line, right side).
function setStatus(text, done) {
  const el = $("status");
  el.textContent = text || "";
  el.classList.toggle("done", !!done);
}
function setCellAlt(index, text) {
  let i = 0;
  for (const row of D.project.rows) for (const c of row.columns) { if (i === index) c.alt = text || null; i++; }
}
// Run fn over items with up to `n` in flight. Collects (doesn't throw) errors.
async function pool(items, n, fn) {
  let i = 0; const errs = [];
  const worker = async () => {
    while (i < items.length) { const idx = items[i++]; try { await fn(idx); } catch (e) { errs.push(e); } }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return errs;
}

// Auto Alt: OCR every slice in parallel, STREAMING each result into the panel as it
// lands. Local AI gets 4 workers; remote stays at 1. Warns before overwriting.
async function runOCR() {
  if (!D) return;
  const cfg = currentAICfg();
  if (!validateAICfg(cfg)) return;
  const hasAlt = D.project.rows.some((r) => r.columns.some((c) => c.alt && c.alt.trim()));
  if (hasAlt && !confirm("Overwrite alt text for all slices?")) return;

  const cells = D.project.rows.flatMap((r) => r.columns).map((_, i) => i); // grid indices
  const total = cells.length;
  const concurrency = cfg.mode === "local" ? 4 : 1; // local can take parallel; cloud stays polite
  const prompt = ocrPrompt();
  pushUndo();
  setBusy(true); showSpin(`Reading text… 0/${total}`); setStatus(`OCR 0/${total}`);
  let done = 0;
  const errs = await pool(cells, concurrency, async (index) => {
    const b64 = await cropSliceB64(vis().image, sliceRect(D.project, index), vis());
    const text = await OCR.transcribe(cfg, prompt, b64);
    setCellAlt(index, text);
    done++;
    showSpin(`Reading text… ${done}/${total}`);
    setStatus(`OCR ${done}/${total}`);
    refreshPanel(); // stream the result into the right pane
  });
  setBusy(false); hideSpin();
  if (errs.length) { setStatus(`OCR: ${done}/${total} (${errs.length} failed)`, true); alert("Some slices failed: " + errs[0].message); }
  else setStatus(`OCR complete · ${total} slices`, true);
}

// Per-slice OCR (the tiny button) — re-transcribes ONE slice, no overwrite warning.
async function ocrOne(index) {
  if (!D) return;
  const cfg = currentAICfg();
  if (!validateAICfg(cfg)) return;
  setBusy(true); showSpin("Reading slice…"); setStatus("OCR 1 slice…");
  try {
    pushUndo();
    const b64 = await cropSliceB64(vis().image, sliceRect(D.project, index), vis());
    const text = await OCR.transcribe(cfg, ocrPrompt(), b64);
    setCellAlt(index, text);
    refreshPanel();
    setStatus("OCR slice done", true);
  } catch (err) {
    D.history.pop();
    setStatus("OCR failed", true);
    alert("OCR failed: " + err.message);
  } finally {
    setBusy(false); hideSpin();
  }
}

// ---- project save / load ---------------------------------------------------

async function saveProject() {
  if (!D) return;
  setBusy(true); showSpin("Preparing project…");
  try {
    const layers = [];
    for (const l of D.layers) {
      const { base64, mime } = await PF.imageToBase64(l.imageUrl);
      layers.push({
        id: l.id, name: l.name, mime, data: base64,
        x: l.x, y: l.y, scale: l.scale, opacity: l.opacity, visible: l.visible,
      });
    }
    const bundle = PF.assembleBundle(D.project, layers, vis().id);
    const stem = (D.name || "project").replace(/\.[^.]+$/, "");
    await PF.saveBundle(bundle, `${stem}.slice`);
  } catch (err) {
    if (err.name !== "AbortError") alert("Save failed: " + err.message);
  } finally {
    setBusy(false); hideSpin();
  }
}

async function openProject(file) {
  setBusy(true);
  try {
    const { project, layers, activeLayer } = PF.parseBundle(await file.text());
    // Decode each embedded layer at its NATIVE size, restoring its placement.
    // (Older bundles have no transform fields -> identity defaults.)
    const docLayers = [];
    for (const l of layers) {
      const url = URL.createObjectURL(PF.layerToFile(l, l.name || "layer.png"));
      const layer = makeLayer(l.id, l.name || file.name, url);
      layer.x = l.x || 0;
      layer.y = l.y || 0;
      layer.scale = l.scale || 1;
      layer.opacity = l.opacity ?? 1;
      layer.visible = l.visible !== false;
      docLayers.push(layer);
    }
    const activeIdx = Math.max(0, layers.findIndex((l) => l.id === activeLayer.id));
    project.image = docLayers[activeIdx].name;

    const doc = makeDoc(project, docLayers[0], file.name);
    doc.layers = docLayers;
    doc.activeLayer = activeIdx;
    doc.nextLayerId = docLayers.length + 1;
    await Promise.all(docLayers.map(loadLayerImage));
    docs.push(doc);
    enableUI(true);
    switchTo(docs.length - 1);
  } catch (err) {
    alert("Open project failed: " + err.message);
  } finally {
    setBusy(false);
  }
}

function enableUI(on) {
  ["autodetect", "export", "replace", "saveProject", "addLayer", "scaleBtn"].forEach((id) => ($(id).disabled = !on));
}
function setBusy(b) { document.body.style.cursor = b ? "progress" : ""; }

// Spinner overlays ONLY the right slice pane, never blocks other UI. Export/save only.
function showSpin(msg) { $("spinnerMsg").textContent = msg || "Working…"; $("spinner").classList.add("show"); }
function hideSpin() { $("spinner").classList.remove("show"); }

// ---- wiring ----------------------------------------------------------------

$("file").addEventListener("change", (e) => { if (e.target.files.length) openFiles([...e.target.files]); e.target.value = ""; });
$("replace").addEventListener("change", (e) => { if (e.target.files[0]) replaceImage(e.target.files[0]); e.target.value = ""; });
$("autodetect").addEventListener("click", autodetect);
$("export").addEventListener("click", (e) => doExport(e.shiftKey));
$("saveProject").addEventListener("click", saveProject);
$("openProject").addEventListener("change", (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ""; });
$("addLayer").addEventListener("change", (e) => { if (e.target.files[0]) addLayer(e.target.files[0]); e.target.value = ""; });
$("diffToggle").addEventListener("click", toggleDiff);
$("scaleBtn").addEventListener("click", openScaleModal);
$("magnetToggle").addEventListener("click", () => {
  if (!D) return;
  D.magnet = !D.magnet;
  renderLayers();
});

// Warn before leaving the page while any document is open.
window.addEventListener("beforeunload", (e) => {
  if (docs.length) { e.preventDefault(); e.returnValue = ""; }
});

["dragover", "dragenter"].forEach((t) =>
  stage.addEventListener(t, (e) => { e.preventDefault(); stage.classList.add("drag"); })
);
["dragleave", "drop"].forEach((t) =>
  stage.addEventListener(t, (e) => { e.preventDefault(); stage.classList.remove("drag"); })
);
// Sort dropped files: .slice -> open as new tabs; images -> layer or new docs.
function handleDrop(files, asLayer) {
  const slices = files.filter((f) => f.name.toLowerCase().endsWith(".slice"));
  const imgs = files.filter((f) => !f.name.toLowerCase().endsWith(".slice"));
  slices.forEach(openProject); // each .slice = a new tab
  if (imgs.length) {
    if (asLayer && D) imgs.forEach(addLayer);
    else openFiles(imgs);
  }
}
stage.addEventListener("drop", (e) => {
  const files = [...e.dataTransfer.files];
  if (files.length) handleDrop(files, true); // onto open doc: images = version layers
});

// Drop on the tab bar -> always open as NEW doc(s) / tabs.
const tabsEl = $("tabs");
["dragover", "dragenter"].forEach((t) =>
  tabsEl.addEventListener(t, (e) => { e.preventDefault(); tabsEl.classList.add("drop"); })
);
["dragleave", "drop"].forEach((t) =>
  tabsEl.addEventListener(t, (e) => { e.preventDefault(); tabsEl.classList.remove("drop"); })
);
tabsEl.addEventListener("drop", (e) => {
  const files = [...e.dataTransfer.files];
  if (files.length) handleDrop(files, false); // tab bar: always new tabs
});

// Stop the browser from navigating to an image dropped anywhere else on the page.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

$("replace").disabled = true;

// ---- AI OCR settings (runtime, persisted client-side) ----------------------

// Default alt-text instructions (editable per user). Kept in sync with the server's
// fallback in core/ai/index.js.
const DEFAULT_OCR_PROMPT = `Transcribe the exact text shown in this image, verbatim. Rules:
- Output ONLY the transcribed text. No descriptions, no "this shows", no preface.
- Insert " | " between visually distinct sub-sections (for example a separate button or call-to-action).
- Do NOT insert " | " inside a single continuing sentence — keep sentences whole.
- If there is no text in the image, output nothing.
- Replace any double quotes(") with single quotes(')
- If the text is in a non-English language, output it as-is, without translation.
- Ignore arrow symbols such as →, >, ⏵
`;

// Presentation modes. Local + OpenAI share the openai-compatible provider; they differ
// only by default endpoint and whether an API key is needed.
const AI_MODES = {
  local: { provider: "openai", base: "http://localhost:1234/v1", endpoint: true, key: false, model: true,
    hint: "Local server (LM Studio, Ollama). No API key — set the endpoint, then Connect for models." },
  openai: { provider: "openai", base: "https://api.openai.com/v1", endpoint: false, key: true, model: true,
    hint: "OpenAI cloud. Paste your OpenAI API key, then Connect for models." },
  anthropic: { provider: "anthropic", base: "", endpoint: false, key: true, model: true,
    hint: "Anthropic Claude. Paste your Claude API key, then Connect for models." },
  google: { provider: "google", base: "", endpoint: false, key: true, model: false,
    hint: "Google Cloud Vision. Paste a Cloud API key with the Vision API enabled. Robust on colored / custom-font text." },
  tesseract: { provider: "tesseract", base: "", endpoint: false, key: false, model: false,
    hint: "Offline OCR — no setup, but weak on custom fonts / colored backgrounds. Prefer a vision model above." },
};
let aiMode = "local";

function loadAICfg() { try { return JSON.parse(localStorage.getItem("slaicer.ai") || "{}"); } catch { return {}; } }
function aiCfgFromInputs() {
  const prompt = $("aiPrompt").value.trim();
  return {
    provider: $("aiProvider").value, mode: aiMode, baseUrl: $("aiBase").value.trim(),
    model: $("aiModel").value, key: $("aiKey").value, maxTokens: Number($("aiMaxTokens").value) || undefined,
    prompt: prompt && prompt !== DEFAULT_OCR_PROMPT ? prompt : undefined, // only store overrides
  };
}
function setModelOptions(models, selected) {
  const sel = $("aiModel");
  sel.innerHTML = "";
  if (selected && !models.includes(selected)) models = [selected, ...models];
  if (!models.length) { sel.innerHTML = '<option value="">— connect for models —</option>'; return; }
  for (const m of models) { const o = document.createElement("option"); o.value = m; o.textContent = m; sel.appendChild(o); }
  if (selected) sel.value = selected;
}
function saveAICfg() { localStorage.setItem("slaicer.ai", JSON.stringify(aiCfgFromInputs())); }
function setAIMode(mode, resetBase) {
  aiMode = mode;
  const m = AI_MODES[mode];
  $("aiProvider").value = m.provider;
  document.querySelectorAll(".aitab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  $("aiEndpointRow").style.display = m.endpoint || m.key ? "flex" : "none";
  $("aiBase").style.display = m.endpoint ? "" : "none"; // LM endpoint only shows for Local
  $("aiKey").style.display = m.key ? "" : "none";
  $("aiModelRow").style.display = m.model ? "flex" : "none";
  $("aiHint").textContent = m.hint;
  // Preset the base (even when the field is hidden, e.g. OpenAI) so the provider has it.
  if (m.base && (resetBase || !$("aiBase").value.trim())) $("aiBase").value = m.base;
}
function deriveMode(c) {
  if (c.mode && AI_MODES[c.mode]) return c.mode;
  if (c.provider === "anthropic") return "anthropic";
  if (c.provider === "tesseract") return "tesseract";
  if (c.provider === "google") return "google";
  return (c.baseUrl || "").includes("openai.com") ? "openai" : "local";
}
(function initAICfg() {
  const c = loadAICfg();
  $("aiBase").value = c.baseUrl || "";
  $("aiKey").value = c.key || "";
  $("aiMaxTokens").value = c.maxTokens || 16384;
  $("aiPrompt").value = c.prompt || DEFAULT_OCR_PROMPT;
  setModelOptions([], c.model || "");
  setAIMode(deriveMode(c), false);
})();
document.querySelectorAll(".aitab").forEach((t) =>
  t.addEventListener("click", () => { setAIMode(t.dataset.mode, true); saveAICfg(); })
);
["aiBase", "aiKey", "aiModel", "aiMaxTokens", "aiPrompt"].forEach((id) => {
  $(id).addEventListener("change", saveAICfg);
  $(id).addEventListener("input", saveAICfg);
});
$("aiConnect").addEventListener("click", aiConnect);
$("autoAlt").addEventListener("click", runOCR);

async function aiConnect() {
  const btn = $("aiConnect");
  btn.disabled = true; btn.textContent = "…";
  try {
    const models = await OCR.listModels(aiCfgFromInputs());
    setModelOptions(models, $("aiModel").value);
    if (!models.length) alert("Connected, but no models reported.");
  } catch (e) {
    alert("Connect failed: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
  }
}

// ---- email build (HTML generator) ------------------------------------------

function emailMeta() {
  if (!D.project.email) D.project.email = { subject: "", preview: "", preheader: "", config: "" };
  return D.project.email;
}
function activeConfig() {
  const list = Configs.loadConfigs();
  return list.find((c) => c.name === emailMeta().config) || list[0];
}
function fillConfigDropdown() {
  const sel = $("emConfig");
  const list = Configs.loadConfigs();
  const cur = emailMeta().config || (list[0] && list[0].name) || "";
  sel.innerHTML = "";
  for (const c of list) { const o = document.createElement("option"); o.value = c.name; o.textContent = c.name; sel.appendChild(o); }
  sel.value = cur;
}
function refreshEmailPanel() {
  if (!D) return;
  const m = emailMeta();
  $("emSubject").value = m.subject || "";
  $("emPreview").value = m.preview || "";
  $("emPreheader").value = m.preheader || "";
  fillConfigDropdown();
}
function genEmailHtml() {
  const m = emailMeta();
  return generateHtml(D.project, activeConfig(), { subject: m.subject, preview: m.preview, preheader: m.preheader });
}

$("emSubject").addEventListener("input", () => { emailMeta().subject = $("emSubject").value; });
$("emPreview").addEventListener("input", () => {
  emailMeta().preview = $("emPreview").value;
  $("emPreheader").placeholder = $("emPreview").value || "Preheader (defaults to preview)";
});
$("emPreheader").addEventListener("input", () => { emailMeta().preheader = $("emPreheader").value; });
$("emConfig").addEventListener("change", () => { emailMeta().config = $("emConfig").value; });

$("copyHtml").addEventListener("click", async () => {
  if (!D) return;
  const { html, warnings } = genEmailHtml();
  try { await navigator.clipboard.writeText(html); setStatus("HTML copied" + (warnings.length ? " (with warnings)" : ""), true); }
  catch { openViewModal(html, warnings); } // clipboard blocked -> show modal to copy manually
});
$("viewHtml").addEventListener("click", () => { if (D) { const { html, warnings } = genEmailHtml(); openViewModal(html, warnings); } });
function closeView() { $("viewModal").hidden = true; }
$("viewClose").addEventListener("click", closeView);
// Click the backdrop (not the box) to close.
$("viewModal").addEventListener("mousedown", (e) => { if (e.target === $("viewModal")) closeView(); });

// Ace editors for the HTML fields. Created LAZILY the first time their modal opens —
// creating them on a display:none element leaves them unrendered. Guarded so a blocked
// CDN can't brick the app.
const hasAce = typeof ace !== "undefined";
let aceView = null, aceHeader = null, aceFooter = null;
function ensureAceView() { if (!aceView && hasAce) aceView = makeAce("viewArea", { readOnly: true }); return aceView; }
function ensureAceCfg() {
  if (aceHeader || !hasAce) return;
  aceHeader = makeAce("cfgHeader", { onChange: () => commitCfgFields() });
  aceFooter = makeAce("cfgFooter", { onChange: () => commitCfgFields() });
}

function openViewModal(html, warnings) {
  $("viewModal").hidden = false;
  ensureAceView();
  if (aceView) { aceView.setValue(html, -1); requestAnimationFrame(() => aceView.resize(true)); }
  else $("viewArea").textContent = html;
  $("viewWarn").textContent = warnings && warnings.length ? "⚠ " + warnings.join("  ") : "";
  $("viewWarn").hidden = !(warnings && warnings.length);
}

// ---- settings modal (config templates) -------------------------------------

const CFG_FIELDS = { cfgName: "name", cfgCompany: "companyName", cfgWidth: "width", cfgBase: "baseUrl", cfgParams: "autoAppendParams" };
let cfgEditing = 0; // index into configs list
let cfgLoading = false; // suppress commit while programmatically loading fields

function fillCfgList(selectIdx) {
  const list = Configs.loadConfigs();
  const sel = $("cfgSelect");
  sel.innerHTML = "";
  list.forEach((c, i) => { const o = document.createElement("option"); o.value = i; o.textContent = c.name; sel.appendChild(o); });
  cfgEditing = Math.max(0, Math.min(selectIdx ?? cfgEditing, list.length - 1));
  sel.value = cfgEditing;
  loadCfgFields(list[cfgEditing]);
}
function loadCfgFields(c) {
  if (!c) return;
  cfgLoading = true; // ace 'change' fires on setValue — don't let it overwrite siblings
  for (const [id, key] of Object.entries(CFG_FIELDS)) $(id).value = c[key] || "";
  aceHeader?.setValue(c.header || "", -1);
  aceFooter?.setValue(c.footer || "", -1);
  cfgLoading = false;
}
function commitCfgFields() {
  if (cfgLoading) return;
  const list = Configs.loadConfigs();
  const c = list[cfgEditing]; if (!c) return;
  for (const [id, key] of Object.entries(CFG_FIELDS)) c[key] = $(id).value;
  if (aceHeader) c.header = aceHeader.getValue();
  if (aceFooter) c.footer = aceFooter.getValue();
  Configs.saveConfigs(list);
}
function openSettings() {
  $("settingsModal").hidden = false;
  ensureAceCfg(); // create now that the modal (and its containers) have size
  fillCfgList(cfgEditing);
  requestAnimationFrame(() => { aceHeader?.resize(true); aceFooter?.resize(true); });
}
function closeSettings() { commitCfgFields(); $("settingsModal").hidden = true; refreshEmailPanel(); }
$("settingsBtn").addEventListener("click", openSettings);
$("settingsClose").addEventListener("click", closeSettings);
$("settingsModal").addEventListener("mousedown", (e) => { if (e.target === $("settingsModal")) closeSettings(); });
$("cfgSelect").addEventListener("change", () => { commitCfgFields(); cfgEditing = Number($("cfgSelect").value); loadCfgFields(Configs.loadConfigs()[cfgEditing]); });
Object.keys(CFG_FIELDS).forEach((id) => $(id).addEventListener("input", commitCfgFields));
$("cfgNew").addEventListener("click", () => {
  const list = Configs.loadConfigs();
  list.push(Configs.blankConfig("Config " + (list.length + 1)));
  Configs.saveConfigs(list);
  fillCfgList(list.length - 1);
});
$("cfgDelete").addEventListener("click", () => {
  const list = Configs.loadConfigs();
  if (list.length <= 1) { alert("Keep at least one config."); return; }
  if (!confirm(`Delete config "${list[cfgEditing].name}"?`)) return;
  list.splice(cfgEditing, 1);
  Configs.saveConfigs(list);
  fillCfgList(Math.max(0, cfgEditing - 1));
});
$("cfgExport").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([Configs.exportConfigs()], { type: "application/json" }));
  a.download = "slaicer-configs.json"; a.click(); URL.revokeObjectURL(a.href);
});
$("cfgImport").addEventListener("click", () => $("cfgImportFile").click());
$("cfgImportFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { Configs.importConfigs(await f.text()); fillCfgList(0); refreshEmailPanel(); }
  catch (err) { alert("Import failed: " + err.message); }
});

Configs.loadConfigs(); // seed defaults on first run
