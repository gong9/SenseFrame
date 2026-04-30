# SenseFrame

SenseFrame is an offline-first desktop photo culling app for photographers. It imports local folders or RAR archives, builds previews, analyzes technical quality, detects face and eye state, groups near duplicates and similar bursts, then lets the reviewer keep, reject, star, search, and export decisions.

## Current Capabilities

- Electron + React darkroom-style review workspace.
- Folder import with recursive image scanning.
- RAR import through bundled `node-unrar-js`.
- JPEG, PNG, WebP preview generation through `sharp`.
- RAW preview generation through Python `rawpy`.
- HEIC decode attempt through `sharp`, with explicit failure reasons when unsupported.
- SQLite project state and preview cache under Electron user data.
- Technical quality scoring for sharpness, exposure, highlight clipping, and shadow clipping.
- Local face detection with SCRFD/YuNet model paths and stricter OpenCV fallback behavior.
- OCEC-based eye-state analysis with multi-scale crop voting.
- Eye states: open, closed, uncertain, not applicable, and unknown.
- Chinese debug overlay for face boxes, landmarks, and eye crops.
- Near-duplicate grouping for almost identical images.
- Similar-burst grouping for action/scene sequences.
- Group ranking and recommended candidate badges.
- Manual OpenAI semantic enhancement for selected photos when `OPENAI_API_KEY` is configured.
- Mock semantic fallback when no OpenAI key is available.
- Pick, reject, maybe, and star decisions.
- CSV export to `~/Documents/SenseFrame`.
- Batch deletion flow that can delete registered original files only after user confirmation.

## Setup

```bash
pnpm install
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt
cp .env.example .env.local
```

Set `OPENAI_API_KEY` in `.env.local` only if you want real semantic analysis. Local technical, face, eye, and grouping analysis can run without OpenAI.

## Run

```bash
pnpm dev
```

## Build

```bash
pnpm build
```

For a TypeScript-only check:

```bash
pnpm exec tsc --noEmit
```

For a Python worker syntax check:

```bash
.venv/bin/python -m py_compile python/worker.py
```

## Data And Safety

SenseFrame reads source photos from their original location and stores app state separately in Electron's user data directory. Preview caches and SQLite rows can be removed through the app.

Deleting a batch can also delete original photo files, but that path is destructive and must be confirmed by the user in the app before it runs.

## Model Notes

The current local vision path is designed for accuracy over real-time speed:

- Face boxes and landmarks prefer local small face models when available.
- Haar is no longer used as the primary eye decision path.
- Eye classification uses OCEC-style eye crops and conservative merge rules.
- No visible face, back view, or environment-only photos are treated as `not_applicable` for eyes, not as closed-eye failures.
- Small faces, side faces, occlusion, or low-confidence conflicts are kept as reviewable uncertainty instead of automatic rejection.

The longer-term direction is to replace temporary similar-burst heuristics with cached local image embeddings and cosine-similarity grouping.
