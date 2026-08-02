import { mkdir, writeFile, readFile } from "node:fs/promises";

const UA = "GuildmastersCompanion/0.1 (local Alt1 app)";
// Wiki art is one of two sources feeding public/sprites, so it lands in the
// staging area rather than the served folder. Run build-sprites afterwards to
// compose the set the scanner actually loads.
const SPRITE_DIR = "sprite-sources/wiki";
const UI_DIR = "public/ui";

// Interface art is larger than an item icon, so only item sprites get the size cap.
const UI_ICONS = {
  "archaeology": "File:Archaeology.png",
  "chronotes": "File:Chronotes.png",
  "tetracompass": "File:Tetracompass (unpowered).png",
  "journal": "File:Archaeology journal.png",
  "bank": "File:Compass.png",
  "workbench": "File:Dragon mattock.png",
  "materials": "File:Third Age iron.png",
  "magnifying-glass": "File:Magnifying glass.png",
  // Alt1 app list + header brand (Guildmaster’s Companion).
  "app-icon": "File:Master archaeologist's hat detail.png",
};

const data = JSON.parse(await readFile("src/data/archaeology.json", "utf8"));

const lookupImages = async (titles, maxSize) => {
  const found = new Map();

  for (let index = 0; index < titles.length; index += 40) {
    const batch = titles.slice(index, index + 40);
    const url = new URL("https://runescape.wiki/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("prop", "imageinfo");
    url.searchParams.set("iiprop", "url|size");
    url.searchParams.set("titles", batch.join("|"));

    const payload = await fetch(url, { headers: { "User-Agent": UA } }).then((r) => r.json());
    const normalised = new Map(
      (payload.query?.normalized ?? []).map((entry) => [entry.to, entry.from]),
    );

    for (const page of Object.values(payload.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      if (maxSize && (info.width > maxSize || info.height > maxSize)) continue;
      found.set(normalised.get(page.title) ?? page.title, info.url);
    }
  }

  return found;
};

const download = async (url, path) => {
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) return false;
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return true;
};

await mkdir(SPRITE_DIR, { recursive: true });
await mkdir(UI_DIR, { recursive: true });

// Item sprites: artefacts (damaged + restored) and every restoration material.
const spriteJobs = [];
for (const artefact of data.artefacts) {
  spriteJobs.push({ key: `${artefact.id}-restored`, title: `File:${artefact.name}.png` });
  spriteJobs.push({ key: `${artefact.id}-damaged`, title: `File:${artefact.damagedName}.png` });
}
for (const material of data.materials) {
  spriteJobs.push({ key: `mat-${material.id}`, title: `File:${material.name}.png` });
}

const spriteUrls = await lookupImages(
  [...new Set(spriteJobs.map((job) => job.title))],
  40,
);

const artefactManifest = {};
const materialManifest = {};
let downloaded = 0;

for (const job of spriteJobs) {
  const source = spriteUrls.get(job.title);
  if (!source) continue;

  const file = `${job.key}.png`;
  if (!(await download(source, `${SPRITE_DIR}/${file}`))) continue;
  downloaded += 1;

  if (job.key.startsWith("mat-")) {
    materialManifest[job.key.slice(4)] = file;
  } else {
    const [id, kind] = [job.key.slice(0, job.key.lastIndexOf("-")), job.key.split("-").at(-1)];
    artefactManifest[id] ??= {};
    artefactManifest[id][kind] = file;
  }
}

// Interface icons are bundled too so the app renders instantly and works offline.
const uiUrls = await lookupImages(Object.values(UI_ICONS));
const uiManifest = {};

for (const [key, title] of Object.entries(UI_ICONS)) {
  const source = uiUrls.get(title);
  if (!source) continue;
  if (await download(source, `${UI_DIR}/${key}.png`)) uiManifest[key] = `${key}.png`;
}

if (uiManifest["app-icon"]) {
  await writeFile("public/icon.png", await readFile(`${UI_DIR}/app-icon.png`));
} else if (uiManifest.archaeology) {
  await writeFile("public/icon.png", await readFile(`${UI_DIR}/archaeology.png`));
}

await writeFile(
  "src/data/sprites.json",
  `${JSON.stringify({ artefacts: artefactManifest, materials: materialManifest, ui: uiManifest }, null, 2)}\n`,
);

const missingArtefacts = data.artefacts.filter(
  (artefact) => !artefactManifest[artefact.id]?.restored || !artefactManifest[artefact.id]?.damaged,
);
const missingMaterials = data.materials.filter((material) => !materialManifest[material.id]);

console.log(`Downloaded ${downloaded} item sprites into ${SPRITE_DIR} and ${Object.keys(uiManifest).length} UI icons.`);
console.log(`Artefacts missing a sprite: ${missingArtefacts.length}`);
console.log(`Materials missing a sprite: ${missingMaterials.length}`);
for (const material of missingMaterials.slice(0, 10)) console.log(`  - ${material.name}`);
console.log("\nRun `npm run build-sprites` to rebuild public/sprites from the sources.");
