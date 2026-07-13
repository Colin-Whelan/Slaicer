// Claude vision provider — plain fetch (no SDK), so it runs on Node + Deno.
// cfg: key (required), model (optional), maxTokens.

export async function transcribe(imageB64, prompt, cfg = {}) {
  if (!cfg.key) throw new Error("anthropic provider needs an API key");
  const model = cfg.model || "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": cfg.key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(cfg.maxTokens) || 16384,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(j.error && j.error.message) || ""}`.slice(0, 200));
  return (j.content?.find((b) => b.type === "text")?.text || "").trim();
}
