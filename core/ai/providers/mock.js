// Keyless provider for testing the OCR pipeline end-to-end (route -> UI -> export).
// Returns deterministic raw text that exercises the format rules (quotes, legal mark,
// pipe). SLAICER_AI_PROVIDER=mock
export async function transcribe(_buffer, _prompt) {
  return 'Sample "alt" text | Get Tickets books1';
}
