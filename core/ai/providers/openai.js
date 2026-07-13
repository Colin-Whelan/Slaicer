// OpenAI-compatible vision provider: LM Studio, Ollama, OpenAI, etc.
// Env: SLAICER_AI_BASE_URL (e.g. http://localhost:1234/v1 for LM Studio),
//      SLAICER_AI_MODEL, SLAICER_AI_KEY (optional — local servers need none).
// Uses fetch only (no SDK dependency).

// Ensure the endpoint targets the OpenAI-compatible /v1 root (LM Studio/Ollama/OpenAI),
// whether the user typed http://localhost:1234, .../v1, or a trailing slash.
export function normalizeBase(b) {
  b = (b || "").replace(/\/+$/, "");
  return /\/v\d+($|\/)/.test(b) ? b : b + "/v1";
}

export async function transcribe(imageB64, prompt, cfg = {}) {
  const base = normalizeBase(cfg.baseUrl);
  const model = cfg.model || "";
  const key = cfg.key || "not-needed";
  if (!cfg.baseUrl || !model) {
    throw new Error("openai provider needs an endpoint (base URL) and model");
  }
  const body = {
    model,
    temperature: 0,
    max_tokens: Number(cfg.maxTokens) || 16384,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } },
      ],
    }],
  };

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`cannot reach ${base}: ${e.message}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`endpoint ${res.status}: ${detail}`.slice(0, 200));
  }
  const j = await res.json();
  return stripThink(j.choices?.[0]?.message?.content || "");
}

// Drop reasoning-model <think>…</think> blocks (and truncated halves) from output.
export function stripThink(s) {
  s = String(s).replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = s.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) s = s.slice(close + 8); // dangling close: keep what's after
  const open = s.toLowerCase().indexOf("<think>");
  if (open !== -1) s = s.slice(0, open); // dangling open (truncated): drop after
  return s.trim();
}
