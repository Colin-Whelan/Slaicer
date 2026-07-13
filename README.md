# Slaicer

Reconstructs a flattened email PNG into reusable image slices, alt text, links, and
send-ready HTML. See [FEATURES.md](FEATURES.md) for the full feature list.

## Architecture

All image work (decode, detect, crop, resize, zip) runs **in the browser** — the
detector is pure JS and the canvas does the pixels. The server is a **tiny stateless
Deno app**: it serves static files and proxies **cloud** OCR (OpenAI / Claude / Google
Vision). **Local** LM Studio / Ollama and **Tesseract** run entirely in the browser, so
they keep working even on the hosted URL (the browser calls `http://localhost` directly).

## Run (Deno)

```bash
deno task start            # serves on http://localhost:8000
```

Runs both locally and on **Deno Deploy** with no changes — stateless, no native deps.

### Deploy to Deno Deploy
- Entrypoint: `server/deno.ts` (also declared in `deno.json` → `deploy.entrypoint`).
- No env vars required — cloud OCR keys are entered in-app (**Settings → AI**).
- The deployment serves `client/`, `core/`, and `shared/` (the browser imports the pure
  `core/detector` + `core/ocr/format` + `shared/rules.json` directly).

## Dev tooling (Node)

```bash
npm install
npm test                   # vitest (pure core: detector, format, html-gen, zip, …)
node cli/index.js <input.png> [outDir]   # sharp-based CLI (local slicing)
```

`sharp`/`ajv` are **dev-only** (CLI + tests) and are never imported by the Deno server.

## CLI

```bash
node cli/index.js <input.png> [outDir] [--threshold N] [--no-columns]
```

Writes numbered slices + `project.json` to `output/<name>/`.

## OCR alt text (optional)

Off unless a provider is configured (env). The **OCR Alt** button then appears and
transcribes each slice to alt text (single quotes, ` | ` between sub-sections, legal
marks like `books(1)`); exports as `alt.txt`, one line per slice.

```bash
# Local LM Studio (no key) — load a vision model, start its server
SLAICER_AI_PROVIDER=openai \
SLAICER_AI_BASE_URL=http://localhost:1234/v1 \
SLAICER_AI_MODEL=<loaded-vision-model> npm start

# Claude:    SLAICER_AI_PROVIDER=anthropic ANTHROPIC_API_KEY=...  (npm i @anthropic-ai/sdk)
# Tesseract: SLAICER_AI_PROVIDER=tesseract                       (npm i tesseract.js; raw OCR, no pipe logic)
# Mock test: SLAICER_AI_PROVIDER=mock
```

## Architecture

`core/` is UI-free and filesystem-free where it matters — the detector is a pure
function `detect(rawImage, rules) → rows[]`. The CLI, the coming API, and batch mode
are all thin wrappers over the same engine. The `project.json` object is the single
source of truth (`shared/schema.json`).

```
core/
  loader.js         Sharp decode → raw RGB buffer
  detector/         detect() : signal → segment → snap
  project.js        build + validate + assert-tiling
  exporter/         crop slices, atomic write
cli/                terminal wrapper over core/
shared/             schema.json, rules.json, layouts.json
test/               unit + acceptance tests
```

### Key invariants (enforced by `assertTiling`)
- Rows tile the full image height; columns tile each row's width. No gaps, no overlaps.
- All cuts are integer pixel boundaries.
- Re-compositing every slice reproduces the source pixels exactly.
