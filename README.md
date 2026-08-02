# Guildmaster’s Companion

An Alt1 app for RuneScape 3 Archaeology — track damaged and restored artefacts,
materials, collection progress, chronotes, tetracompass pieces, and more.

**Live:** https://plusdivide.github.io/guildmasters-companion-alt1/

**[Add to Alt1](alt1://addapp/https://plusdivide.github.io/guildmasters-companion-alt1/appconfig.json)**

```text
alt1://addapp/https://plusdivide.github.io/guildmasters-companion-alt1/appconfig.json
```

Grant **View screen** (scans) and **Get game state** (mouse for teach + chat watching)
in the app spanner → permissions.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`, or in Alt1:

```text
alt1://browser/http://127.0.0.1:5173
```

## Data refresh (maintainers)

```powershell
npm run sync-data
npm run sync-sprites
npm run build-sprites
npm run build-framed-sprites
```

Assumes RuneScape at **100% interface scale**.

Designed by RuneScape user **Husafell** — PM for requests and feedback.
