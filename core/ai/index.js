// AI layer — PURE (no sharp/fs). Runs on Node and Deno. The browser crops slices and
// sends the image bytes; this only calls the provider + applies the format rules.
//
// config = { provider, mode, baseUrl, model, key, maxTokens, prompt }.
// providers: openai (OpenAI-compatible / LM Studio), anthropic, google, tesseract.

import { formatAlt } from "../ocr/format.js";

const env = (typeof process !== "undefined" && process.env) || {}; // Deno/browser safe

/** Merge client-supplied config over env defaults. */
export function resolveConfig(c = {}) {
  return {
    provider: c.provider || env.SLAICER_AI_PROVIDER || "",
    baseUrl: c.baseUrl || env.SLAICER_AI_BASE_URL || "",
    model: c.model || env.SLAICER_AI_MODEL || "",
    key: c.key || env.SLAICER_AI_KEY || env.ANTHROPIC_API_KEY || "",
    maxTokens: Number(c.maxTokens) || Number(env.SLAICER_AI_MAX_TOKENS) || 16384,
    prompt: (c.prompt && c.prompt.trim()) || "",
  };
}

export function isAIEnabled() {
  return !!resolveConfig().provider;
}

export const ALT_PROMPT = `Transcribe the exact text shown in this image, verbatim. Rules:
- Output ONLY the transcribed text. No descriptions, no "this shows", no preface.
- Insert " | " between visually distinct sub-sections (for example a separate button or call-to-action).
- Do NOT insert " | " inside a single continuing sentence — keep sentences whole.
- If there is no text in the image, output nothing.
- Replace any double quotes(") with single quotes(')
- If the text is in a non-English language, output it as-is, without translation.
- Ignore arrow symbols such as →, >, ⏵
`;

/**
 * Transcribe ONE slice image (base64 PNG) to formatted alt text.
 * @param {string} imageB64  base64 of the slice PNG (no data: prefix)
 */
export async function transcribeImage(imageB64, rawConfig, promptOverride) {
  const cfg = resolveConfig(rawConfig);
  if (!cfg.provider) throw new Error("No AI provider configured");
  let mod;
  try {
    mod = await import(`./providers/${cfg.provider}.js`);
  } catch {
    throw new Error(`Unknown AI provider '${cfg.provider}'`);
  }
  const prompt = promptOverride || cfg.prompt || ALT_PROMPT;
  return formatAlt(await mod.transcribe(imageB64, prompt, cfg));
}

/**
 * List model names at the configured endpoint. openai-compatible -> <baseUrl>/models,
 * anthropic -> /v1/models. Others return [].
 */
export async function listModels(rawConfig) {
  const cfg = resolveConfig(rawConfig);
  if (cfg.provider === "openai") {
    if (!cfg.baseUrl) throw new Error("enter an endpoint first");
    const { normalizeBase } = await import("./providers/openai.js");
    const base = normalizeBase(cfg.baseUrl);
    let res;
    try {
      res = await fetch(`${base}/models`, { headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {} });
    } catch (e) {
      throw new Error(`cannot reach ${base}: ${e.message}`);
    }
    if (!res.ok) throw new Error(`endpoint ${res.status}`);
    const j = await res.json();
    return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
  }
  if (cfg.provider === "anthropic") {
    if (!cfg.key) throw new Error("enter an API key first");
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const j = await res.json();
    return (j.data || []).map((m) => m.id).filter(Boolean);
  }
  return [];
}
