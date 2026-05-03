# SenseFrame

English | [简体中文](README.zh-CN.md)

![SenseFrame desktop review workspace](docs/assets/senseframe-main-2026-05-02.png)

SenseFrame is a local-first AI culling workstation for photographers who need to review large shoots without losing control of their own taste.

It turns a folder of hundreds or thousands of images into a focused review desk: strongest candidates first, risky frames separated, near-duplicates grouped, bursts compared, and Xiaogong ready to reorganize the workspace around the task you ask for.

## Why SenseFrame

- **Built for real culling work**: import, compare, keep, reject, rate, and export from one focused desktop workspace.
- **Local-first by default**: original photos stay on your machine, with review state and previews stored separately.
- **Fast first-pass structure**: technical issues, eye risks, subject issues, duplicates, bursts, and pending frames are separated before you start manual review.
- **Burst-aware review**: similar frames are grouped so you compare the right photos against each other instead of scrolling endlessly.
- **Xiaogong as a review co-pilot**: ask it to find the strongest images, review possible mistakes, explain a recommendation, or create a task-specific photo view.
- **Learns your taste over time**: Xiaogong is designed to learn from accepted suggestions, rejected picks, ratings, exports, and your own review instructions.
- **Photographer stays in control**: AI organizes and explains; final keep, maybe, reject, rating, and export choices remain yours.

## Key Features

- Import local folders or RAR archives.
- Generate thumbnails and review previews.
- Organize photos into candidate, eye review, subject issue, technical issue, duplicate, similar burst, and pending views.
- Group near-duplicates and similar bursts for faster comparison.
- Mark photos as keep, maybe, reject, and star ratings.
- Search and explain photos with semantic context.
- Run Xiaogong review to let the assistant review the full batch and produce a unified culling result.
- Create Xiaogong views, such as a ranked list of the images it considers strongest.
- Let Xiaogong gradually adapt to your review style through feedback and repeated selections.
- Export selected photos and CSV review lists.

## What Is Xiaogong?

Xiaogong is the photo-review co-pilot inside SenseFrame.

It is not a generic chatbot and not a simple scoring tool. Xiaogong reads the current batch, grouping state, manual decisions, risk signals, and existing review results, then helps organize the workspace around a clear task.

Example requests:

```text
Find the best-looking photos.
Review possible closed-eye mistakes.
Pick one representative from each burst.
Explain why this photo was recommended.
```

Xiaogong changes the workspace instead of only replying with text: it can create a Xiaogong view, select the first recommended image, sort the filmstrip, and explain the active photo in the inspector.

Over time, Xiaogong is intended to remember what you accept, reject, rate, export, and explicitly ask for, so future recommendations can better match your own photographic taste.

## Current Status

SenseFrame is under active development. The current version is suitable for local testing and product validation. Signed installers, release automation, auto-update, and deeper Xiaogong memory features are planned.

## Run Locally

```bash
pnpm install
pnpm dev
```

Build check:

```bash
pnpm build
```
