# Imagery Pipeline Workflow (compose redesign, 2026-07)

## Overview
The imagery pipeline generates social-media-ready product posts for content calendar entries.
It runs automatically after copy is approved (`status: copy_approved`).

Design principle: the AI only paints the **background**. The product, logo and text are
composited deterministically — the product is never distorted by image-to-image editing,
and any edit (text / product / layout) is a fast recompose with **zero AI cost**.

## Pipeline Steps

### Step 1: Background Generation — `lib/background-gen.js`
- **Prompt derivation:** OpenRouter LLM reads the approved `fb_content` and writes a
  2-3 sentence scene description matched to the post (festival / weather / mood).
  Falls back to the deterministic pillar/festival tables when the LLM is unavailable.
  Hard constraints appended in code: no fan, no text, visible ceiling space, uncluttered
  lower third.
- **Generation:** provider registry via `IMAGE_PROVIDER` env (default `gpt-image-2`,
  OpenAI images.generate — pure text-to-image, 1024x1024, quality via
  `GPT_IMAGE_QUALITY`). Registry slots reserved for Jimeng / nano banana.
- **Storage:** background uploaded to Supabase Storage `backgrounds/…` (survives
  redeploys; enables recompose at any time). URL kept in `compose_spec.background_url`
  and mirrored to `scene_image_url`.
- **Dry-run:** no `OPENAI_API_KEY` → skips only the image API call.

### Step 2: Deterministic Composition — `lib/compose.js` + `lib/brand-kit.js`
- Product asset from `assets/products/` (SVG rasterized at density 300; assets without
  real transparency get a white rounded card), placed per `compose_spec.product_slot`.
- Brand logo top-left (`assets/brand/fanz-logo.png` — placeholder wordmark until Fanz
  provides the official transparent logo; swap the file, zero code changes).
- Text via `lib/text-overlay.js` with brand presets (title position from
  `compose_spec.title_slot`, plus selling_point / cta / promo_badge).
- Same spec → same output. No AI involved.

### Step 3: Store Image — `lib/store-image.js`
- Uploads the final composited image to Supabase Storage, writes `image_url`
  (timestamped path, idempotent per `image_url`).

## compose_spec (jsonb on content_calendar)
Records every composition input: `background_url`, `background_prompt`, `product`,
`product_slot`, `title_slot`, `texts{}`. The Dashboard's "Edit Text & Layout" merges
edits into it and sets `review_notes='[recompose]'` + `status='image_retry'`; the worker
recomposes on the stored background in seconds.

Migration (required for editing; the pipeline tolerates its absence and simply
regenerates instead of reusing):
```sql
alter table content_calendar add column if not exists compose_spec jsonb;
```

## review_notes markers (consumed and cleared by the worker)
| Marker | Effect | AI cost |
|--------|--------|---------|
| `[scene] <description>` | new background with the requested scene, recompose | 1 image |
| `[product-next]` | cycle product, recompose on the same background | none |
| `[recompose]` | recompose with the edited compose_spec | none |

## Environment Variables
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | image generation (gpt-image-2) |
| `OPENROUTER_API_KEY` | Yes | — | background prompt derivation |
| `BG_PROMPT_MODEL` | No | `MODEL` / gpt-4o | model for prompt derivation |
| `IMAGE_PROVIDER` | No | `gpt-image-2` | background provider key |
| `GPT_IMAGE_QUALITY` | No | `medium` | low / medium / high |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Yes | — | DB + Storage |

## State Machine (image_status)
```
pending → generating → generated
                    ↘ failed → generating (retry)
```
The claim (`→ generating`) is a conditional PATCH guarded on the read value; a lost
race is contention, not failure. Post-store status writes are ordered so the main
status (`image_ready`) lands before the image_status flip; `recoverStuckRows` backstops
stranded `generating` rows.

## Key Files
- `lib/background-gen.js` — prompt derivation + provider registry + cloud upload
- `lib/compose.js` — sharp composition (product / logo / text)
- `lib/brand-kit.js` — layout config (slots, presets, logo)
- `lib/text-overlay.js` — sharp SVG text compositing
- `lib/store-image.js` — Supabase Storage upload
- `lib/pipeline.js` — orchestrator + compose_spec persistence
- `lib/scene-gen.js` — legacy; only the pillar/festival scene tables are still used

## Testing
```bash
# Deterministic composition (no API, no DB) — outputs in /tmp/compose-test for eyeballing
node test-compose.js

# Full real chain (real OpenRouter + image API + Storage + DB scratch row, self-cleaning)
source .env && node test-compose-pipeline-real.js

# Structure + integration (dry-run without OPENAI_API_KEY)
node test-pipeline.js
```
Do NOT run worker-chain tests while a real plan is `in_production` — the live worker
races on the same rows.
