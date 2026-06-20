# Bulk Auto-Fill Across All Characters

**Date:** 2026-06-20
**Status:** Approved

## Summary

The archive curation UI already has a per-character, per-field "Auto-fill"
action (`render`, `figures`, `abilityIcons`) that picks already-tagged
images for that one character from preferred categories. With ~213
characters, running it one at a time means hundreds of clicks. Add a single
header-toolbar button that runs the same logic across every character in
one pass, with one important behavior change: it never overwrites an
existing `render` (only fills characters that have none), while `figures`
and `abilityIcons` keep their existing additive-only behavior.

## Context

- Per-character auto-fill: `autoFillCharField(sky, field)`
  (`scripts/reclassify-tumblr.mjs:1176-1196`), triggered by buttons at
  `scripts/reclassify-tumblr.mjs:2207` (figures/abilityIcons, via
  `profGallery`) and `:2309` (render).
- `render` auto-fill today **unconditionally overwrites** whatever render is
  currently set with the first match from `RENDER_CATS`. `figures`/
  `abilityIcons` auto-fill is **additive only** — it only adds newly-tagged
  images not already present in that field.
- Persistence: `saveCharField(name, patch)`
  (`scripts/reclassify-tumblr.mjs:1199-1209`) POSTs to `/api/update-character`,
  merges the patch into the in-memory `SKYLANDERS` entry, then calls
  `render()`. Called once per save today (one field at a time, one character
  at a time) — fine for a single click, wasteful at ~213×.
- Established UI pattern to mirror: `publishArchive()`
  (`scripts/reclassify-tumblr.mjs:1116-1138`) — disables its button, updates
  an adjacent status `<span>` (`.ok`/`.err` classes), re-enables on
  completion. The header toolbar already composes
  `tagModeBtnHTML`/`addImageBtnHTML`/`publishBtnHTML` the same way
  (`scripts/reclassify-tumblr.mjs:1808`), each a standalone template-literal
  constant that gets `.replace()`-stripped out of `htmlPublish` for the
  `--publish` build (`scripts/reclassify-tumblr.mjs:3160-3168`) — editing
  actions never ship to the published static site.
- Established confirm-before-destructive-action pattern:
  `scripts/reclassify-tumblr.mjs:920` (image removal) — a native `confirm()`
  with a one-sentence explanation of what happens.

## Decisions Made

| Question | Decision |
|---|---|
| `render` field scope | Only fill characters with no render set — never overwrite an existing one |
| `figures`/`abilityIcons` scope | Unchanged (additive-only), applied to every character |
| Trigger placement | Header toolbar button, alongside "+ Add Image" / "Publish" |
| Visibility | Curation-only — stripped from the published site, same mechanism as the other editing buttons |
| Confirmation | Native `confirm()` before starting, matching the existing image-removal pattern |
| API calls | One combined POST per character that needs *any* field changed (not one per field) — characters needing no changes make no call at all |
| Rendering | One `render()` at the end of the whole run, not one per character |
| Error handling | Continue past individual failures; report a final success/failure count rather than aborting on the first error |

## Part 1 — Extract a pure patch-computation helper

**File:** `scripts/reclassify-tumblr.mjs`

Replace `autoFillCharField` (`:1176-1196`) with a pure helper plus a thin
wrapper that preserves the existing per-character button behavior exactly:

```js
function computeAutoFillPatch(sky, field, { onlyIfMissing = false } = {}) {
  const lname = sky.name.toLowerCase();
  const byCat = imagesByCategory(lname);
  const cats  = field === 'render' ? RENDER_CATS : field === 'figures' ? FIGURE_CATS : ABILITY_CATS;

  if (field === 'render') {
    if (onlyIfMissing && sky.render) return null;
    for (const c of cats) {
      const pick = (byCat[c] || [])[0];
      if (pick) return { render: pick.path };
    }
    return null;
  }

  const existing = new Set(sky[field] || []);
  const additions = [];
  for (const c of cats) {
    for (const img of (byCat[c] || [])) {
      if (!existing.has(img.path) && !additions.includes(img.path)) additions.push(img.path);
    }
  }
  return additions.length ? { [field]: [...(sky[field] || []), ...additions] } : null;
}

function autoFillCharField(sky, field) {
  const patch = computeAutoFillPatch(sky, field);
  if (patch) saveCharField(sky.name, patch);
}
```

Both existing call sites (`:2207`, `:2309`) call `autoFillCharField` exactly
as before — no change needed there. `onlyIfMissing` defaults to `false`, so
the per-character render button keeps its current overwrite behavior
unchanged; only the new bulk path (Part 3) passes `onlyIfMissing: true`.

## Part 2 — Non-rendering save variant

**File:** `scripts/reclassify-tumblr.mjs`

Split `saveCharField` (`:1199-1209`) into a raw POST+merge function and a
thin wrapper that adds the render:

```js
async function saveCharFieldRaw(name, patch) {
  const sky = SKYLANDERS.find(s => s.name === name);
  const res = await fetch('/api/update-character', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ...patch })
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  if (sky) Object.assign(sky, patch);
}

async function saveCharField(name, patch) {
  try {
    await saveCharFieldRaw(name, patch);
    render();
  } catch (e) {
    alert('Error saving: ' + e.message);
  }
}
```

Every existing caller of `saveCharField` (there are several across the
file, all single-character single-action flows) is unaffected — same
signature, same behavior, same per-call render + alert-on-error.
`saveCharFieldRaw` is new and only consumed by Part 3.

## Part 3 — Bulk action, button, and status wiring

**File:** `scripts/reclassify-tumblr.mjs`

**HTML** — new template-literal constant, following the exact shape of
`publishBtnHTML` (`:438-440`), inserted into the header
(`:1808`, alongside the existing `${tagModeBtnHTML}${addImageBtnHTML}${publishBtnHTML}`)
and into the `--publish` strip list (`:3160-3168`, alongside the existing
`.replace(publishBtnHTML, '')` line):

```js
const autoFillAllBtnHTML = `
  <button id="autofill-all-btn" onclick="autoFillAllCharacters()" title="Fill in missing renders and add any newly-tagged figures/ability icons, across every character">Auto-fill All</button>
  <span id="autofill-all-status"></span>`;
```

**Logic** — new function, placed near `publishArchive` for proximity to the
pattern it mirrors:

```js
async function autoFillAllCharacters() {
  if (!confirm('Auto-fill every character?\\n\\nFills in renders only for characters that have none, and adds any newly-tagged figures/ability icons to every character. Existing renders are never overwritten.')) return;

  const btn = document.getElementById('autofill-all-btn');
  const statusEl = document.getElementById('autofill-all-status');
  btn.disabled = true;
  statusEl.className = '';

  let updated = 0, failed = 0;
  const total = SKYLANDERS.length;
  for (let i = 0; i < total; i++) {
    const sky = SKYLANDERS[i];
    statusEl.textContent = 'Auto-filling\\u2026 ' + (i + 1) + '/' + total;
    const patch = {};
    for (const field of ['render', 'figures', 'abilityIcons']) {
      const fieldPatch = computeAutoFillPatch(sky, field, { onlyIfMissing: field === 'render' });
      if (fieldPatch) Object.assign(patch, fieldPatch);
    }
    if (Object.keys(patch).length) {
      try {
        await saveCharFieldRaw(sky.name, patch);
        updated++;
      } catch (e) {
        failed++;
      }
    }
  }

  render();
  statusEl.className = failed ? 'err' : 'ok';
  statusEl.textContent = (failed ? '\\u26a0 ' : '\\u2713 ') + 'Auto-filled ' + updated + '/' + total + ' characters' + (failed ? ' \\u2014 ' + failed + ' failed' : '');
  btn.disabled = false;
}
```

## Error Handling / Edge Cases

- **Character needs no changes** (already has a render, and no new
  figures/ability-icon images tagged): `patch` stays `{}`, no API call is
  made for that character, doesn't count toward `updated` or `failed`.
- **Individual save fails** (network blip, server error): caught per-character,
  counted in `failed`, loop continues to the next character rather than
  aborting the whole run.
- **User cancels the `confirm()`:** function returns immediately, nothing
  runs, no button-disable, no status change.
- **No tagged images exist for a category at all:** `computeAutoFillPatch`
  already handles this (existing behavior, unchanged) — returns `null` for
  `render` when no category has a match, returns `null` for `figures`/
  `abilityIcons` when there's nothing new to add.

## Testing

No test framework in this project (consistent with all prior plans).
Verification is manual, via the running curation server (`archive-server.mjs`):

1. Confirm the per-character "Auto-fill" buttons (render, figures, ability
   icons) still behave exactly as before for a single character — this is
   the regression check that Part 1's refactor didn't change anything.
2. Confirm "Auto-fill All" does **not** appear in the published
   (`--publish`) build's HTML output.
3. Pick a character with an existing render and some untagged figure images
   available; run "Auto-fill All"; confirm that character's render is
   unchanged but new figures got added.
4. Pick a character with no render set; run "Auto-fill All"; confirm it now
   has a render filled in.
5. Confirm the status span shows live progress during the run and a final
   count on completion.
6. Confirm cancelling the `confirm()` dialog does nothing.
