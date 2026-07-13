// Slaicer server for Node — dev / staging runtime. Mirrors server/deno.ts exactly:
// static hosting + cloud OCR proxy. Stateless, no sharp/multer/fs-state.
//   npm run dev     (node server/node.js)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeImage, listModels } from "../core/ai/index.js";

const PORT = Number(process.env.PORT) || 8000;
const REPO = fileURLToPath(new URL("..", import.meta.url)); // repo root
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".map": "application/json",
};

const readBody = (req) =>
  new Promise((res, rej) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); req.on("error", rej); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (obj, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  // cloud AI proxy (OpenAI / Claude / Google). Local + Tesseract run in the browser.
  if (req.method === "POST" && url.pathname === "/api/ocr") {
    try { const { config, prompt, image } = JSON.parse(await readBody(req)); json({ text: await transcribeImage(image, config, prompt) }); }
    catch (e) { json({ error: e.message }, 400); }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/ai/models") {
    try { const { config } = JSON.parse(await readBody(req)); json({ models: await listModels(config) }); }
    catch (e) { json({ error: e.message }, 400); }
    return;
  }

  // static: /core & /shared from the repo root; everything else from client/
  let p = decodeURIComponent(url.pathname);
  const fsPath = p.startsWith("/core/") || p.startsWith("/shared/")
    ? join(REPO, p)
    : join(REPO, "client", p === "/" ? "index.html" : p);
  if (!normalize(fsPath).startsWith(normalize(REPO))) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const data = await readFile(fsPath);
    res.writeHead(200, { "content-type": TYPES[extname(fsPath)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch { res.writeHead(404); res.end("Not found"); }
});

server.listen(PORT, () => console.log(`Slaicer (Node) on http://localhost:${PORT}`));
