# SenseFrame Design System

SenseFrame is a professional photo culling workstation for photographers. It should feel like a precision darkroom instrument: calm, technical, tactile, and visually refined. This is not a marketing page, not a generic SaaS dashboard, and not a decorative AI demo.

This file is the visual source of truth for coding agents. When editing UI, read this first and preserve the product direction unless the user explicitly asks to change it.

## Design Direction

### Core Metaphor

SenseFrame is a digital light table with AI inspection marks.

- The photograph is the primary object.
- The interface is optical equipment around the photo.
- Controls should feel like camera controls, contact sheets, focus marks, and lab instruments.
- AI output should feel like an assistant layer, not a chatbot layer.

### Product Feeling

- Calm darkroom workstation, not black admin panel.
- Photography-first: the image is always the hero; controls stay quiet.
- Technical but restrained: optical glass, focus marks, sensor grids, precise HUD labels.
- Repeated professional use: dense, scannable, ergonomic, low-drama.
- Chinese UI copy should be short, direct, and workflow-oriented.

### Aesthetic Anchors

- Industrial darkroom.
- Optical inspection surface.
- Professional contact sheet.
- Camera focus overlay.
- Editorial photo desk.

Do not drift into futuristic sci-fi, gaming HUD, crypto dashboard, generic enterprise SaaS, or landing-page hero design.

## Product Reference Positioning

SenseFrame should learn from adjacent photography tools without copying any single interface.

### darktable

Use darktable as the closest conceptual reference: a professional virtual lighttable and darkroom.

- Borrow the metaphor of a serious photographic workspace.
- Borrow the split between image review surface, filmstrip, and technical side panels.
- Borrow the idea that professional tools can be dense without becoming decorative.
- Do not copy darktable's full editing-panel complexity; SenseFrame is for culling, not raw development.

### QuickRawPicker And raw-viewer

Use RAW culling tools as workflow references.

- Prioritize fast image switching.
- Keep rating and keep/reject actions close to the image.
- Avoid modal-heavy interactions during review.
- Preserve keyboard-first review speed.
- Do not overbuild metadata panels when the user is deciding between nearby frames.

### nomacs

Use nomacs as a reference for quiet image-viewer overlays.

- Metadata and controls can float over the image stage when they stay compact.
- Translucent panels should support inspection instead of becoming visual decoration.
- Zoom and thumbnail controls should feel like viewing tools, not page navigation.

### PhotoPrism And LocalLens

Use AI photo-library products only as cautionary references.

- Borrow local/AI-assisted organization ideas where useful.
- Do not adopt consumer gallery aesthetics.
- Do not make SenseFrame feel like a personal photo album, cloud gallery, or social browsing app.

### Design Synthesis

SenseFrame should combine:

- darktable's professional lighttable/darkroom seriousness,
- QuickRawPicker/raw-viewer's fast culling workflow,
- nomacs-style quiet metadata overlays,
- and a restrained AI review layer.

The result should feel like a photography review instrument: faster and calmer than a full editor, more professional than a gallery, and more visual than a data dashboard.

## Visual Theme And Atmosphere

### Mood

- Quiet, focused, and deliberate.
- High contrast where decisions matter; low contrast where chrome should recede.
- Subtle texture through grids, hairlines, and layered black surfaces.
- No ornamental blobs, pastel gradients, glassy toy cards, or playful rounded pills.

### Density

- The workspace may be dense, but every module needs breathing room.
- Left sidebar is a navigation and batch control rail, not a packed settings drawer.
- Inspector is a technical reading panel, not a stack of marketing cards.
- Filmstrip is compact but must remain readable at a glance.

### Memorability

The memorable element should be the photo on a gridded review surface with restrained AI marks. Do not make the sidebar, buttons, or badges louder than the image.

## Color Palette And Roles

Use CSS variables in `src/styles.css` as the implementation source. These are the intended semantic roles:

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Canvas black | `--bg-0` | `#050607` | App background, image stage base |
| Sidebar black | `--bg-1` | `#080b0d` | Sidebar and secondary dark regions |
| Surface black | `--bg-2` | `#0c1114` | Cards, controls, score surfaces |
| Panel | `--panel` | `rgba(15, 20, 23, 0.86)` | Layered panels |
| Strong panel | `--panel-strong` | `rgba(18, 25, 29, 0.94)` | Active or raised panels |
| Hairline | `--line` | `rgba(192, 215, 220, 0.12)` | Default borders and separators |
| Active line | `--line-strong` | `rgba(141, 230, 224, 0.35)` | Active AI/tool states |
| Text | `--text` | `#f2f5f2` | Primary labels |
| Muted text | `--muted` | `#8d9797` | Metadata and secondary text |
| Quiet text | `--muted-2` | `#667071` | Section labels and low-priority hints |
| Optical cyan | `--cyan` | `#7de4dc` | AI buckets, focus marks, active technical state |
| Champagne gold | `--gold` | `#dac27c` | Selected photos, primary import, best/recommended state |
| Soft red | `--red` | `#e07878` | Reject/destructive states only |

### Color Rules

- Cyan means active intelligence, focus, analysis, or technical selection.
- Gold means chosen, best, primary import, recommended, or photographer intent.
- Red is reserved for reject/destructive states. Do not use red for general warnings unless deletion or rejection is involved.
- Avoid large cyan or gold fills. Prefer 1px borders, 2px state bars, small badges, and thin progress lines.
- The image must remain more colorful than the interface.

## Typography Rules

Use a restrained sans system. The app can use `Inter`, `Noto Sans SC`, and system UI fonts, but the design must not feel like generic SaaS. Character comes from proportion, density, and optical details, not novelty fonts.

### Type Scale

| Level | Size | Weight | Usage |
| --- | ---: | ---: | --- |
| Display | 24px | 760 | Topbar current view title |
| Panel title | 18px | 720 | Inspector photo filename, brand name |
| Body emphasis | 13px | 680-720 | Buttons, active list labels |
| Body | 13px | 400-560 | Metadata and explanatory text |
| Small | 12px | 500-680 | Score labels, decision pills, secondary controls |
| Micro | 11px | 500-700 | Section labels, badges, HUD eyebrow text |

### Typography Rules

- Letter spacing is normally `0`.
- Section labels may use uppercase with `0.12em` to `0.16em` letter spacing.
- Numeric scores should be large enough to scan, but not oversized. Prefer 22px in cards, 16px in summary metrics, 12-13px in list counts.
- Hashes and IDs should use monospace only when they are secondary metadata.
- Chinese labels should avoid filler words. Use `保留`, `待定`, `淘汰`, `批次`, `精选`, `复核`, `已选`.

## Layout Principles

### Global Structure

- Left rail: import, batch context, AI grouping, operational navigation.
- Center: image review surface. This owns the screen.
- Right inspector: current photo evidence, decision controls, quality signals.
- Bottom filmstrip: contact sheet for nearby frame comparison.

### Proportions

- Sidebar width should stay around 292px unless a feature truly needs more.
- Inspector width should stay around 410px.
- Topbar should be compact: 78-88px depending on density.
- Filmstrip should be compact: 96-104px.
- Image stage should fill all remaining space and preserve image bounds.

### Spacing Scale

Use this spacing rhythm:

- 4px: tiny internal gaps, icon/text tuning.
- 6px: compact list gaps.
- 8px: default component gap.
- 10-12px: normal card/control padding.
- 14-16px: module separation inside sidebars.
- 18-22px: major panel padding.
- 28px+: topbar horizontal page padding or empty-state layout.

Avoid arbitrary one-off spacing values unless solving a concrete alignment issue.

## Component Styling

### Buttons

- Default button height: 32-34px.
- Primary import button: 38px, gold fill, square-ish 4px corners.
- Toolbar buttons: 34px, icon + label, quiet border, no pill shape.
- Decision buttons: equal-width segmented row, 34-36px height.
- Icon buttons: stable square dimensions, no layout shift on hover.
- Corners: 4px default, 6px maximum for larger surfaces.

Do not use large rounded pills. SenseFrame should feel like equipment, not a mobile wellness app.

### Sidebar Summary Metrics

- Four compact metric cells.
- Value: 16px, high contrast.
- Label: 11px, muted.
- Keep metrics visually lighter than batch cards and active AI buckets.

### Batch Cards

- Batch cards represent workspace context, not primary actions.
- Row height: 44-50px.
- Current batch uses gold border and a slim state bar.
- Batch ID/hash is secondary and may be clipped.
- Delete is quiet and only visually strong on hover.
- Do not let batch history push AI group navigation out of view.

### AI Bucket Cards

- AI buckets are the primary navigation for review work.
- Row height: 42-50px depending on available vertical space.
- Active bucket uses cyan border/fill and a left inset mark.
- Icons use Lucide, 16px, single consistent stroke style.
- Counts are boxed but quiet; they should not look like primary buttons.

### Image Stage

- The stage is a gridded light table.
- The grid should be visible but never compete with the image.
- HUD is translucent black with a cyan left rule.
- HUD should show bucket, filename, and position only.
- Zoom controls sit over the canvas but must not cover critical content more than necessary.

### Inspector

- Inspector is for evidence and decisions.
- Photo title: 18px.
- Metadata: 13px muted.
- Score cards: 2-column grid, compact, values around 22px.
- Risk tags: small 12px chips with subtle border.
- Decision controls must be easy to hit and visually balanced with score cards.

### Filmstrip

- Thumbnail size: about 92x74px to 96x78px.
- Active thumbnail uses gold border.
- Pick state uses cyan bottom mark.
- Reject state fades but remains identifiable.
- Badges are small, square, and high contrast.
- Never make the filmstrip taller than needed; it should support comparison, not dominate.

## Interaction And Motion

- Use 120-220ms transitions for color, border, opacity, and slight transform only.
- Hover may change border/background, but must not shift layout.
- Image switching must not flash blank or resize old image with new dimensions.
- Prefer preserving visual continuity over dramatic transitions.
- Respect `prefers-reduced-motion`.
- Keyboard navigation should remain first-class: arrow keys, pick/reject/maybe, star rating.

## Image And Debug Rules

- Image fit must preserve full image bounds.
- Zoom is canvas zoom/pan, never browser scroll.
- Debug boxes must use the same coordinate system as the displayed image.
- Debug labels are Chinese.
- Debug overlays should look like camera focus/analysis marks, not web form boxes.
- Do not let controls cover critical image content more than necessary.

## Copywriting Rules

### Voice

- Short, operational, direct.
- Chinese first in UI.
- Avoid explaining obvious controls inside the active workspace.
- Prefer verbs for actions and nouns for navigation.

### Good Labels

- `导入`
- `调试框`
- `导出已选`
- `重建近重复`
- `重跑分析`
- `精选候选`
- `疑似闭眼`
- `待判断`

### Avoid

- Marketing copy in active workspace.
- Long instructions under controls.
- English labels in operational UI unless they are file formats like `RAR` or `CSV`.

## Do Not

- Do not use landing-page hero composition inside the app workspace.
- Do not use pastel SaaS cards or oversized decorative panels.
- Do not use visible browser scroll as the image viewing interaction.
- Do not treat back view, no-face, or environmental storytelling photos as bad by default.
- Do not let batch lists push AI categories out of view.
- Do not use dense explanatory copy in the active workspace.
- Do not make buttons, cards, and panels each follow different sizing systems.
- Do not use emoji as UI icons.
- Do not introduce purple-blue gradients, rounded wellness UI, or generic AI dashboard visuals.

## Responsive And Window Behavior

- Minimum working desktop size is approximately 1180x760.
- On short windows, hide secondary descriptions before shrinking primary labels.
- Reduce AI bucket and batch row heights before reducing readable font sizes.
- Keep import, metrics, batch context, and at least several AI buckets visible in the left rail.
- The center image must remain inspectable at all supported sizes.

## Agent Implementation Checklist

Before finalizing UI changes:

- Does the image remain the hero?
- Do topbar, sidebar, inspector, and filmstrip share the same type scale?
- Are button heights consistent?
- Are corners 6px or less?
- Are cyan and gold used semantically?
- Did any hover state cause layout shift?
- Is the left rail breathable without wasting space?
- Can the user quickly compare, decide, and export?
- Did the change avoid generic AI/SaaS aesthetics?
- Did `npm run typecheck` pass?

## Reference Inspiration

These references informed the structure of this document, but SenseFrame should keep its own photography-first darkroom identity:

- `darktable-org/darktable`: professional virtual lighttable/darkroom reference.
- `RawLabo/QuickRawPicker`: RAW culling workflow reference.
- `catdad/raw-viewer`: minimal desktop RAW review/culling reference.
- `nomacs/nomacs`: quiet image viewer overlays and metadata panel reference.
- `photoprism/photoprism`: AI photo-library cautionary reference; useful for organization, not for workspace aesthetics.
- `ashesbloom/LocalLens`: local AI photo organization cautionary/reference point.
- `VoltAgent/awesome-design-md`: structured DESIGN.md files for AI agents, including sections for visual theme, palette, typography, components, layout, elevation, guardrails, responsive behavior, and prompt guidance.
- Anthropic `frontend-design` skill: commit to a clear aesthetic direction and avoid generic AI-generated UI patterns.
- UI/UX Pro Max style guidance: use product-specific design systems, consistent controls, accessibility checks, and stack-aware implementation.
