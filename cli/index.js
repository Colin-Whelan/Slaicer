#!/usr/bin/env node
// Thin CLI wrapper over core/. Proves the engine end-to-end without any UI.
//
//   node cli/index.js <input.png> [outDir] [--threshold N] [--no-columns]
//
import path from "node:path";
import { loadImage } from "../core/loader.js";
import { detect } from "../core/detector/index.js";
import { buildProject, assertTiling } from "../core/project.js";
import { exportProject } from "../core/exporter/index.js";

function parseArgs(argv) {
  const args = { rules: {} };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold") args.rules.threshold = Number(argv[++i]);
    else if (a === "--no-columns") args.rules.detectColumns = false;
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else pos.push(a);
  }
  args.input = pos[0];
  args.outDir = pos[1];
  return args;
}

async function main() {
  const { input, outDir, rules } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error("Usage: node cli/index.js <input.png> [outDir] [--threshold N] [--no-columns]");
    process.exit(1);
  }
  const out = outDir || path.join("output", path.basename(input, path.extname(input)));

  const img = await loadImage(input);
  const rows = detect(img, rules);
  const project = buildProject(path.basename(input), img, rows, rules);
  assertTiling(project);

  const { count } = await exportProject(input, project, out);
  const cells = project.rows.reduce((n, r) => n + r.columns.length, 0);
  console.log(`Detected ${project.rows.length} rows, ${cells} cells.`);
  console.log(`Wrote ${count} slices + project.json to ${out}/`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
