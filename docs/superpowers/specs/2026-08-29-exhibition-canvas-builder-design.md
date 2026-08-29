# Exhibition Canvas Builder — Design (Phase 1)

## Goal

Replace the current tag-driven, fixed-grid "Exhibition" mechanism (`exhibition.njk` +
`artworkTag` + a plain image grid) with a freeform canvas builder inside Studio:
a tool where artwork, text, and a background can be placed, sized, and rotated
anywhere on a fixed-size stage, producing a hand-crafted exhibition page —
closer in spirit to mmmm.page than to a portfolio grid.

This is Phase 1 of a two-phase project (see [[project-quaint-lab]] context from
this conversation): building the tool itself. Phase 2 — migrating the existing
Karat exhibition into this format, building the new Helix Vacui exhibition with
it, and redesigning `/atelier/` to be exhibitions-first — is separate future
work and depends on this phase being done first.

Private authoring, public output: the builder lives in Studio
(`localhost:3001`, private), but what it produces is a real page on the public
site.

## Architecture

**Per-exhibition files**, under `src/posts/exhibitions/`:

- `{slug}.md` — small frontmatter file: `posttitle`, `layout:
  exhibition-canvas.njk`, `permalink`, `canvasWidth`, `canvasHeight`,
  `background` (a CSS color string). Default canvas size for new exhibitions:
  1600×1000 — large enough for a real composition, editable per-exhibition at
  creation time.
- `{slug}.canvas.json` — a flat array of placed elements:
  ```json
  [
    {
      "id": "el-1", "type": "image", "src": "sergio-winter.png",
      "x": 120, "y": 80, "width": 300, "height": 400,
      "rotation": -8, "zIndex": 3, "opacity": 1
    },
    {
      "id": "el-2", "type": "text", "content": "Sergio's story begins...",
      "x": 400, "y": 50, "width": 250,
      "rotation": 0, "zIndex": 5, "opacity": 1,
      "fontSize": 18, "color": "#eeeeee", "align": "left"
    }
  ]
  ```
  `src` is relative to `/images/artwork/`, matching every other artwork
  reference in this codebase. `width`/`height` on a text element sets its box
  width; height is automatic based on content.

**One shared stylesheet, two consumers.** `src/css/exhibition-canvas.css`
defines exactly how canvas elements render: the fixed-size stage, per-element
absolute positioning via inline `style` (position/size/rotation/opacity/
z-index are per-instance, so they're written as inline styles by whichever
side is rendering — builder or public template — not baked into this file),
plus shared rules like text element typography and the stage's own
background-color hookup. Both the public `exhibition-canvas.njk` template and
Studio's builder page load this *same file* — Studio's server gets a new
static passthrough route, `/css/* → src/css/*` (mirroring the existing
`/images/* → src/images/*` passthrough already in `studio/server.js`), so
there is one file, not two copies that could drift. The builder adds its own
separate stylesheet on top for editor-only chrome (selection outlines, resize
handles, panel layout) — never for anything that affects how a placed element
actually looks.

**Public rendering**: the fixed-size stage is wrapped in a container that
scales the whole thing to fit the viewport width (`transform: scale(ratio)`
where `ratio = wrapperWidth / canvasWidth`, recalculated on resize, with
`transform-origin: top left` and the wrapper's height set to
`canvasHeight * ratio` so the page's layout flow isn't broken by the
transform). This was chosen specifically so a hand-placed composition never
reflows or reinterprets positions across devices — it only ever scales as a
whole, per your decision earlier in this conversation.

## Components (Studio builder UI)

Three-column layout, matching Studio's existing Atelier view shape:

- **Left — Art palette**: thumbnails from your artwork library, populated via
  the existing `GET /api/images?folder=src/images/artwork` endpoint (no new
  endpoint needed). Click or drag a thumbnail onto the canvas to place it as a
  new image element at a default position/size.
- **Center — Canvas workspace**: the fixed-size stage at edit-time zoom.
  Elements are draggable (pointer events), resizable via 8 corner/edge
  handles, and rotatable via a handle above the element — the standard
  drag/resize/rotate pattern from tools like Figma or PowerPoint. An "Add
  Text" button drops a new, immediately-editable text box. A background color
  picker sets the exhibition's `background` field.
- **Right — Properties panel**: fields for whatever's currently selected —
  x/y/width/height/rotation/opacity/layer for any element, plus
  content/font-size/color/alignment for text — and bring-to-front /
  send-to-back controls for `zIndex`.
- **Save**: one action, persists both files at once.

## Data flow (new endpoints on `studio/server.js`)

- `GET /api/exhibitions` — list existing exhibitions (slug, title)
- `GET /api/exhibition?slug=X` — reads `{slug}.md` frontmatter and
  `{slug}.canvas.json` together, returns `{ meta, elements }`
- `POST /api/exhibition` — creates a new exhibition: `{slug}.md` with the
  given title/canvas size/background, and an empty `{slug}.canvas.json`
  (`[]`)
- `PUT /api/exhibition` — saves `{ meta, elements }` back to both files

## Error handling

- No save-conflict/locking logic — Studio is single-user and local, matching
  every other editing flow it already has.
- A missing/renamed image referenced by an element renders a visible
  broken-image placeholder, in both the builder and the public page, rather
  than crashing either.
- `{slug}.canvas.json` read/parse and per-element rendering in
  `exhibition-canvas.njk` are wrapped so a malformed file degrades that one
  exhibition to an empty/error-noted page instead of failing the whole
  Eleventy build.

## Testing

No automated test suite exists in this repo (confirmed: no test runner
configured, no test files anywhere) — verification is manual, matching
project convention:

1. Build the site, load a real exhibition page in a browser, confirm it
   matches what was composed in the builder (the WYSIWYG guarantee from the
   shared stylesheet).
2. Exercise the builder directly: add an image, add text, drag/resize/rotate
   several elements, reorder layers, change the background, save, reload the
   page, confirm every value round-trips exactly.
3. Temporarily rename an image referenced by a placed element; confirm both
   the builder and the public page show a broken-image placeholder rather
   than erroring.
4. Temporarily corrupt a `.canvas.json` file; confirm the Eleventy build
   still completes and only that one exhibition page degrades.

## Out of scope (this phase)

- **Rollout** — migrating Karat, building Helix Vacui, redesigning
  `/atelier/` to be exhibitions-first with a secondary browse-everything page.
  Phase 2, brainstormed separately once this tool exists and has been used.
- **Decorative stickers/blinkies as placeable elements** — considered during
  scoping, deferred; only images, text, and background are in v1.
- **Adaptive/responsive reflow** — explicitly rejected in favor of
  scale-as-a-whole; each exhibition's layout is fixed by design.
- **A vendored interaction library or SVG-based canvas** — considered as
  alternative approaches; hand-rolled vanilla JS was chosen to match Studio's
  existing zero-dependency frontend.
