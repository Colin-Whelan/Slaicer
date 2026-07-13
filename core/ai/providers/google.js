// Google Cloud Vision OCR. Edge/Deno-friendly (single REST call, no Python service).
// Env/config: key = a Google Cloud API key with the Vision API enabled.
// Raw OCR (not instructable) — the deterministic format pass still applies. Far more
// robust than Tesseract on custom fonts / colored backgrounds, but no sentence-aware
// pipe reasoning like a vision LLM.

export async function transcribe(imageB64, _prompt, cfg = {}) {
  const key = cfg.key;
  if (!key) throw new Error("Google Vision needs a Cloud API key (Vision API enabled)");
  const body = {
    requests: [{
      image: { content: imageB64 },
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
    }],
  };
  let res;
  try {
    res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`cannot reach Google Vision: ${e.message}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Vision ${res.status}: ${(j.error && j.error.message) || ""}`.slice(0, 200));
  const text = j.responses?.[0]?.fullTextAnnotation?.text || "";
  // Vision separates visual blocks with blank lines — treat those as sub-sections.
  return text.replace(/\n{2,}/g, " | ").replace(/\n/g, " ").trim();
}
