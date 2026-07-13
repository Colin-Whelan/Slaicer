// .slice project bundle — a single self-contained file holding the slice grid,
// names, and the image(s) so a project round-trips fully. Shaped to carry layers
// (Phase 2) and future OCR/alt/link/HTML without a format change.
//
// The assemble/parse helpers are pure (no DOM/network) so they're unit-testable.

import { IS_LOCAL } from "./config.js";

export const BUNDLE_FORMAT = "slaicer-project";
export const BUNDLE_VERSION = 1;

/**
 * Build a bundle object from a project + its layers (each with base64 image data).
 * Layers carry their placement (offset/scale) and view state (opacity/visible) so
 * a project round-trips pixel-perfect; older bundles simply lack the fields.
 * @param {object} project   schema project (rows/columns incl. name/link/alt)
 * @param {Array} layers     [{ id, name, mime, data(base64), x, y, scale, opacity, visible }]
 * @param {string} activeLayerId  id of the active (exported) layer
 */
export function assembleBundle(project, layers, activeLayerId) {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    project: structuredClone(project),
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name || "layer",
      mime: l.mime || "image/png",
      data: l.data,
      x: l.x || 0,
      y: l.y || 0,
      scale: l.scale || 1,
      opacity: l.opacity ?? 1,
      visible: l.visible !== false,
    })),
    activeLayer: activeLayerId || layers[0].id,
  };
}

/** Parse + validate a bundle. Returns { bundle, project, layers, activeLayer }. Throws on bad input. */
export function parseBundle(text) {
  let bundle;
  try {
    bundle = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw new Error("Not a valid project file (bad JSON)");
  }
  if (!bundle || bundle.format !== BUNDLE_FORMAT) {
    throw new Error("Not a Slaicer project file");
  }
  if (!bundle.project || !Array.isArray(bundle.project.rows)) {
    throw new Error("Project file is missing slice data");
  }
  if (!Array.isArray(bundle.layers) || bundle.layers.length === 0) {
    throw new Error("Project file has no image layers");
  }
  const active = bundle.layers.find((l) => l.id === bundle.activeLayer) || bundle.layers[0];
  return { bundle, project: bundle.project, layers: bundle.layers, activeLayer: active };
}

// --- browser IO helpers (DOM/network) --------------------------------------

const bytesToB64 = (bytes) => {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};
export const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Fetch an image URL and return its base64 + mime. */
export async function imageToBase64(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { base64: bytesToB64(bytes), mime: blob.type || "image/png" };
}

/** Decode a layer's base64 image into a File for upload. */
export function layerToFile(layer, filename = "layer.png") {
  return new File([b64ToBytes(layer.data)], filename, { type: layer.mime || "image/png" });
}

/**
 * Save a bundle. Local mode -> real Save dialog (File System Access). If that's
 * unavailable/blocked (Firefox, sandboxed iframe), or in hosted mode, fall back to a
 * browser download. User cancel (AbortError) is propagated — never a silent download.
 */
export async function saveBundle(bundle, suggestedName) {
  const text = JSON.stringify(bundle);
  if (IS_LOCAL && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: "Slaicer project", accept: { "application/json": [".slice"] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return handle.name;
    } catch (e) {
      if (e && e.name === "AbortError") throw e; // user cancelled -> stop, no download
      // else picker blocked (iframe/security) -> fall through to download
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(a.href);
  return suggestedName;
}
