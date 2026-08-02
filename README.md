# Guildmaster’s Companion

An Alt1-ready web app for tracking damaged/restored Archaeology artefacts,
material storage, collection progress, chronotes, restoration XP, tetracompass
pieces, and other recurring collection rewards.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Open in Alt1

With the development server running, open:

```text
alt1://browser/http://127.0.0.1:5173
```

Alt1 reads `public/appconfig.json` and shows `public/icon.png` in the app list.
Grant **View screen** (scans) and **Get game state** (mouse for teach + chat watching)
in the app spanner → permissions.

## Data

```powershell
npm run sync-data
npm run sync-sprites
npm run build-sprites
npm run build-framed-sprites
```

Sprites live in `public/sprites` / `public/sprites-framed` and `public/ui`.
Nothing is fetched from the wiki at runtime.

## Screen scanning

One **Scan** button stitches the open storage interface, then matches with the
correct isolated system:

| Interface | Matcher |
|-----------|---------|
| Bank | `src/bank-stitch-match.ts` + `bank-soft-locate*` |
| Archaeologist’s Workbench | `src/workbench-stitch-match.ts` + `workbench-soft-locate*` |
| Material Storage | `src/material-stitch-match.ts` |

These three systems do not share soft-locate or result assembly. The excavation
watcher reads chat in the background while the app is open.

Assumes RuneScape at **100% interface scale**.

## Offline parity

```powershell
node --experimental-strip-types scripts/diag/parity-all.mjs
```

Expect: bank 56 claims · materials 40 / 0 unresolved · workbench 53 claims / 5 cols.

Optional benches: `bench-bank-soft-locate.mjs`, `bench-workbench-soft-locate.mjs`.

## Build and deploy

```powershell
npm run build
```

Pushing to `main` runs `.github/workflows/deploy.yml` for GitHub Pages.

### Live app (GitHub Pages)

Once deployed:

- App: `https://plusdivide.github.io/rs3-archaeology-companion/`
- Open in Alt1: `alt1://addapp/https://plusdivide.github.io/rs3-archaeology-companion/appconfig.json`
