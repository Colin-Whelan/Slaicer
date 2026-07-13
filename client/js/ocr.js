// Client OCR routing:
//   local (LM Studio / Ollama)  -> browser calls the endpoint DIRECTLY (works when
//                                  hosted too: localhost is mixed-content-exempt).
//   tesseract                   -> runs in-browser (tesseract.js via CDN).
//   openai / anthropic / google -> POST /api/ocr (Deno cloud proxy).
import { formatAlt } from "/core/ocr/format.js";

const normalizeBase = (b) => { b = (b || "").replace(/\/+$/, ""); return /\/v\d+($|\/)/.test(b) ? b : b + "/v1"; };

function stripThink(s) {
  s = String(s).replace(/<think>[\s\S]*?<\/think>/gi, "");
  const c = s.toLowerCase().lastIndexOf("</think>"); if (c !== -1) s = s.slice(c + 8);
  const o = s.toLowerCase().indexOf("<think>"); if (o !== -1) s = s.slice(0, o);
  return s.trim();
}

async function localOpenAI(cfg, prompt, b64) {
  const res = await fetch(`${normalizeBase(cfg.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key || "not-needed"}` },
    body: JSON.stringify({
      model: cfg.model, temperature: 0, max_tokens: Number(cfg.maxTokens) || 16384,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`endpoint ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j = await res.json();
  return stripThink(j.choices?.[0]?.message?.content || "");
}

async function tesseractClient(b64) {
  const T = await import("https://esm.sh/tesseract.js@6");
  const createWorker = T.createWorker || T.default.createWorker;
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(`data:image/png;base64,${b64}`);
    return (data?.text || "").replace(/\s*\n\s*/g, " ").trim();
  } finally { await worker.terminate(); }
}

async function cloudProxy(cfg, prompt, b64) {
  const res = await fetch("/api/ocr", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: cfg, prompt, image: b64 }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `ocr ${res.status}`);
  return j.text; // already formatted server-side
}

/** cfg = the AI settings; b64 = base64 PNG of the slice. Returns formatted alt text. */
export async function transcribe(cfg, prompt, b64) {
  const mode = cfg.mode || "local";
  if (mode === "local") return formatAlt(await localOpenAI(cfg, prompt, b64));
  if (mode === "tesseract") return formatAlt(await tesseractClient(b64));
  return await cloudProxy(cfg, prompt, b64);
}

export async function listModels(cfg) {
  const mode = cfg.mode || "local";
  if (mode === "local") {
    const res = await fetch(`${normalizeBase(cfg.baseUrl)}/models`, { headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {} });
    if (!res.ok) throw new Error(`endpoint ${res.status}`);
    const j = await res.json();
    return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
  }
  const res = await fetch("/api/ai/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: cfg }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `models ${res.status}`);
  return j.models || [];
}
