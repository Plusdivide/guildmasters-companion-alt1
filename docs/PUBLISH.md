# Publish checklist (live / `main`)

Use this before merging or pushing the **live** Guildmaster’s Companion app.

## Must check

- [ ] **Developer tools off for public.** In `src/dev-tools.ts`, `ENABLE_DEV_TOOLS` must be `false` so Settings has no Developer section and detection outlines / watcher mode card stay unavailable.
- [ ] **App name** is `Guildmaster’s Companion` (no “dev build” suffix) in:
  - `public/appconfig.json` (`appName`)
  - `index.html` (`<title>`)
  - `src/main.ts` header brand (`<h1>`)
- [ ] **Player data persists on live.** In `src/store.ts`, `DISCARD_PLAYER_STATE_ON_CLOSE` must be `false` (or only temporarily `true` for local wizard tests). Never ship a hard-coded `true` to `main` — that makes production forget inventory on every close.
- [ ] Spot-check a **production** build (`npm run build` / GitHub Pages): close and reopen still restores setup + inventory.
- [ ] First-run welcome + scan wizard copy looks correct; no leftover WIP-only UI.
- [ ] README / screenshots updated if the product changed.
- [ ] **Experimental:** `COMPACT_SCAN_PREVIEW` in `src/main.ts` — packed flowing icon grid (no spatial gaps, no named hits list, + add slot). Set `false` to restore the old bank-layout preview.

## After publish

- [ ] Live Add-to-Alt1 link still works: `https://plusdivide.github.io/guildmasters-companion-alt1/add.html`
- [ ] Local `npm run dev` persists player data (same as live). Set `DISCARD_PLAYER_STATE_ON_CLOSE` to `true` temporarily only if you need a fresh-install wizard test.
