// Slaicer server for Deno / Deno Deploy. Stateless: static hosting + cloud OCR
// proxy only. All image work happens in the browser (see client/js/{detect,crop,ocr}).
// No sharp, no filesystem state, no multer.
//
//   deno task start   (or: deno run -A server/deno.ts)

import { serveDir } from "@std/http/file-server";
import { transcribeImage, listModels } from "../core/ai/index.js";

const PORT = Number(Deno.env.get("PORT")) || 8000;
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // --- cloud AI proxy (OpenAI / Claude / Google Vision). Local + Tesseract run in
  //     the browser; they never hit the server. ---
  if (req.method === "POST" && url.pathname === "/api/ocr") {
    try {
      const { config, prompt, image } = await req.json();
      return json({ text: await transcribeImage(image, config, prompt) });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/ai/models") {
    try {
      const { config } = await req.json();
      return json({ models: await listModels(config) });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // --- static files (relative to cwd = repo root, both local and on Deploy) ---
  const headers = ["cache-control: no-cache"];
  if (url.pathname.startsWith("/core/") || url.pathname.startsWith("/shared/")) {
    return serveDir(req, { fsRoot: ".", quiet: true, headers }); // pure modules served to the browser
  }
  return serveDir(req, { fsRoot: "client", urlRoot: "", quiet: true, headers });
}

Deno.serve({ port: PORT }, handler);
console.log(`Slaicer (Deno) on http://localhost:${PORT}`);
