// No-key local OCR via tesseract.js. Raw text only — cannot do the semantic ' | '
// sub-section rule (no layout reasoning); the deterministic format pass still applies.
// Optional dep: tesseract.js (lazy-imported). SLAICER_AI_PROVIDER=tesseract

export async function transcribe(imageB64, _prompt) {
  let mod;
  try {
    mod = await import("tesseract.js");
  } catch {
    throw new Error("tesseract provider needs: npm i tesseract.js");
  }
  const createWorker = mod.createWorker || mod.default?.createWorker;
  if (!createWorker) throw new Error("tesseract.js: createWorker not found");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(Buffer.from(imageB64, "base64"));
    return (data?.text || "").replace(/\s*\n\s*/g, " ").trim();
  } finally {
    await worker.terminate();
  }
}
