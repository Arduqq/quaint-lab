# Studio Home Dashboard — Design

## Goal

Studio (`npm run studio`, `studio/server.js` + `studio/public/`) currently opens
straight to the Writing post list. There's no single place to see the state of
everything: how much content is drafted-but-unpublished, whether the repo has
uncommitted work piling up, or what's going on in the Skylanders archive and
the journey/pets data. This adds a **Home** tab that surfaces all of that at a
glance, so opening Studio feels like arriving at a home base rather than a
content-entry form.

Private/local only — this lives inside Studio (`localhost:3001`), not the
deployed site. No new server, no new dependencies, no persistent/cached state:
every number is computed fresh from disk (and one `git` shell-out) on each
visit, the same way the rest of Studio already works.

## Architecture

- **Tab:** Add `Home` to `.type-tabs` in `studio/public/index.html`, as the
  first tab. It becomes the default view on load (Studio currently defaults
  to `state.type = 'writing'` — change the initial view to Home).
- **View:** New `#home-view` div alongside the existing `#list-view`,
  `#atelier-view`, `#edit-view`, shown/hidden via the same tab-switching logic
  already in `app.js`.
- **Endpoint:** One new handler in `server.js`, `GET /api/dashboard`, that
  aggregates all four widgets' data server-side and returns one JSON object.
  The frontend makes a single fetch and renders four cards from it.

## Widgets & data sources

1. **Content Backlog** — for each type in `writing`, `games`, `artwork`,
   `pets`, run the existing `scanPosts(type)` and filter `draft === true`.
   Response includes per-type counts and the 5 most-recently-dated drafts
   across all types (title, type, file), each linking into the edit view for
   that post (reuse the existing `openEdit(file)`-style flow already used by
   post cards).
2. **Repo / Site Health** — shell out to `git status --porcelain` (already
   have `exec` imported in `server.js` for `/api/build`) from `ROOT`. Parse
   each line's path, bucket by top-level segment under `src/` (`images`,
   `posts`, `pages`, `_includes`, `_data`, `css`, other) the same way used to
   produce the breakdown earlier in this conversation, and report a count per
   bucket plus the total. Also run `git log -1 --format=%cd|%s --date=short`
   for a one-line "last commit" summary.
3. **Skylanders Archive** — read `skylanders-archive/manifest.json` if it
   exists (it's gitignored, so it may be absent in a fresh checkout — see
   Error Handling). Report `posts.length`, total images (`sum of
   posts[].images.length`), featured vs. non-featured image counts (from each
   image's `featured` boolean), and `fetched_at`.
4. **Journey / Pets** — read `src/_data/journey.json` and
   `src/_data/pet_list.json`. Report entry counts for each, plus a grade
   breakdown (A/B/C/D counts) for journey since `grade` is already on every
   entry.

## API contract

`GET /api/dashboard` → `200` with:

```json
{
  "backlog": {
    "counts": { "writing": 0, "games": 2, "artwork": 41, "pets": 0 },
    "recent": [{ "title": "...", "type": "artwork", "file": "src/posts/artwork/..." }]
  },
  "repoHealth": {
    "total": 279,
    "buckets": { "images": 160, "posts": 55, "pages": 14, "_includes": 11, "_data": 9, "css": 5, "other": 25 },
    "lastCommit": { "date": "2026-08-23", "message": "..." }
  },
  "skylanders": {
    "available": true,
    "posts": 1301, "images": 13280, "featured": 0, "nonFeatured": 0,
    "fetchedAt": "2026-06-06T08:49:35.303Z"
  },
  "journeyPets": {
    "journeyCount": 0, "grades": { "A": 0, "B": 0, "C": 0, "D": 0 },
    "petCount": 0
  }
}
```

Each top-level section is computed independently; a failure in one does not
prevent the others from returning (see Error Handling).

## UI

No new visual language. Reuse existing Studio components as-is:

- Cards use the existing `.post-card`-style surface (border, `--surface2` on
  hover) — four cards in a simple grid, not a new layout system.
- Counts/labels use existing `.section-label` and badge styles
  (`.badge-draft`, `.badge-pub`) where they fit conceptually (e.g. backlog
  counts as draft-style badges).
- No charts, graphs, or new color tokens. Numbers and short lists only —
  matches Studio's current plain, dense, utilitarian look.
- The recent-drafts list reuses the existing post-card click-to-edit
  interaction rather than inventing a new navigation pattern.

## Error handling

- `server.js`: each of the four data reads in the `/api/dashboard` handler is
  wrapped in its own try/catch. On failure, that section returns
  `{ available: false }` (or equivalent) instead of throwing — one bad/missing
  file (most likely `skylanders-archive/manifest.json` in a fresh checkout)
  degrades only that card.
- `app.js`: each card renders independently from its section of the response;
  an `available: false` (or missing) section renders a small "unavailable"
  state in that card instead of blocking the other three.
- `git status`/`git log` failures (e.g. run outside a git repo) are caught
  the same way `/api/build`'s `exec` errors are already handled.

## Testing

Studio has no automated test suite today (verified: no test runner/config in
`package.json` for `studio/`). Verification is manual, per the existing
project convention:

1. Run `npm run studio`, confirm Home is the default tab and loads without
   errors.
2. Cross-check each card's numbers against direct commands: `git status
   --porcelain | wc -l`, manual `draft: true` counts per type, manifest
   `posts.length`/image counts via a one-off script, `journey.json`/
   `pet_list.json` array lengths.
3. Rename/move `skylanders-archive/manifest.json` temporarily to confirm that
   card alone degrades gracefully and the other three still render.
4. Click a recent-draft entry and confirm it opens in the edit view.

## Out of scope

- **Self-hosting migration** — raised during brainstorming as a separate,
  later decision. This dashboard is built entirely on the current local
  Studio setup and doesn't depend on or block that decision either way.
- **Deploy-timestamp tracking** — no "last pushed live" marker exists on
  disk today; adding one would mean writing a marker file on every `npm run
  push`, which is a separate small feature, not part of this design.
- **Artwork capture inbox** (watched folder → auto-draft) — the earlier
  thread of this conversation, before it pivoted to the dashboard. Separate
  future design if picked back up.
