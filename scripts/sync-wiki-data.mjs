import { mkdir, writeFile } from "node:fs/promises";

// The wiki's Module:Archaeology_Data is a legacy leftover: it stops before the
// Senntisten dig site and is missing 57 artefacts. The per-artefact pages are
// the live source (they back the wiki's own tables), so the catalogue is built
// from the artefact and collection lists instead.
const API = "https://runescape.wiki/api.php";
const ARTEFACT_LIST = "Artefacts";
const COLLECTION_LIST = "Collections";
const UA = "RS3ArchaeologyCompanion/0.1 (local Alt1 app)";

const fetchPages = async (titles) => {
  const pages = new Map();

  for (let index = 0; index < titles.length; index += 50) {
    const batch = titles.slice(index, index + 50);
    const url = new URL(API);
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("prop", "revisions");
    url.searchParams.set("rvprop", "content");
    url.searchParams.set("rvslots", "main");
    url.searchParams.set("titles", batch.join("|"));

    const response = await fetch(url, { headers: { "User-Agent": UA } });
    if (!response.ok) throw new Error(`RuneScape Wiki returned ${response.status}`);
    const payload = await response.json();

    // Redirects and capitalisation fixes come back under a different title.
    const renamed = new Map(
      [
        ...(payload.query?.normalized ?? []),
        ...(payload.query?.redirects ?? []),
      ].map((entry) => [entry.to, entry.from]),
    );

    for (const page of payload.query?.pages ?? []) {
      const text = page.revisions?.[0]?.slots?.main?.content;
      if (text) pages.set(renamed.get(page.title) ?? page.title, text);
    }
  }

  return pages;
};

// Template bodies nest, so braces are counted rather than matched by regex.
const templateBodies = (text, name) => {
  const bodies = [];
  const needle = `{{${name}`.toLowerCase();
  const haystack = text.toLowerCase();
  let from = 0;

  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;

    // Guard against matching `{{Collections table` when asked for `{{Collection`.
    const next = text[start + needle.length];
    if (next && !"|}".includes(next) && !/\s/.test(next)) {
      from = start + 2;
      continue;
    }

    let depth = 0;
    let index = start;
    while (index < text.length) {
      if (text.startsWith("{{", index)) {
        depth += 1;
        index += 2;
      } else if (text.startsWith("}}", index)) {
        depth -= 1;
        if (depth === 0) {
          bodies.push(text.slice(start + 2, index));
          break;
        }
        index += 2;
      } else index += 1;
    }
    from = index + 1;
  }

  return bodies;
};

const splitParams = (body) => {
  const parts = [];
  let current = "";
  let curly = 0;
  let square = 0;

  for (let index = 0; index < body.length; index += 1) {
    if (body.startsWith("{{", index)) {
      curly += 1;
      current += "{{";
      index += 1;
    } else if (body.startsWith("}}", index)) {
      curly -= 1;
      current += "}}";
      index += 1;
    } else if (body.startsWith("[[", index)) {
      square += 1;
      current += "[[";
      index += 1;
    } else if (body.startsWith("]]", index)) {
      square -= 1;
      current += "]]";
      index += 1;
    } else if (body[index] === "|" && curly === 0 && square === 0) {
      parts.push(current);
      current = "";
    } else current += body[index];
  }

  parts.push(current);
  return parts;
};

const parseTemplate = (body) => {
  const [, ...rest] = splitParams(body);
  const named = {};
  const positional = [];

  for (const part of rest) {
    const split = part.indexOf("=");
    const key = split < 0 ? null : part.slice(0, split).trim();
    // A value containing `=` inside a link is not a named parameter.
    if (key && /^[\w\s-]+$/.test(key)) named[key.toLowerCase()] = part.slice(split + 1).trim();
    else if (part.trim()) positional.push(part.trim());
  }

  return { named, positional };
};

const plain = (value) =>
  (value ?? "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<[^>]*>/g, "")
    .trim();

const number = (value) => {
  const match = plain(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

const slug = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const listPage = async (title, template) => {
  const pages = await fetchPages([title]);
  const text = pages.get(title);
  if (!text) throw new Error(`Could not read the ${title} page`);

  const names = templateBodies(text, template)
    .map((body) => plain(parseTemplate(body).positional[0] ?? ""))
    .filter(Boolean);

  return [...new Set(names)];
};

const artefactNames = await listPage(ARTEFACT_LIST, "Artefact list table row");
const collectionNames = await listPage(COLLECTION_LIST, "Collection");

const artefactPages = await fetchPages(artefactNames);
const collectionPages = await fetchPages(collectionNames);

const artefacts = [];
const skipped = [];

for (const name of artefactNames) {
  const text = artefactPages.get(name);
  if (!text) {
    skipped.push(`${name} (page not found)`);
    continue;
  }

  const info = templateBodies(text, "Infobox Artefact").map(parseTemplate)[0];
  const recipe = templateBodies(text, "Infobox Recipe")
    .map(parseTemplate)
    .find((entry) => Object.keys(entry.named).some((key) => /^mat\d+$/.test(key)));

  if (!recipe) {
    skipped.push(`${name} (no restoration recipe)`);
    continue;
  }

  // Archaeology is normally skill1, but never assume the slot.
  let level = null;
  let restoreXp = null;
  for (const [key, value] of Object.entries(recipe.named)) {
    const slot = key.match(/^skill(\d*)$/);
    if (slot && plain(value).toLowerCase() === "archaeology") {
      level = number(recipe.named[`skill${slot[1]}lvl`]);
      restoreXp = number(recipe.named[`skill${slot[1]}exp`]);
    }
  }

  const materials = [];
  let damagedName = null;

  for (let slot = 1; recipe.named[`mat${slot}`] !== undefined; slot += 1) {
    const material = plain(recipe.named[`mat${slot}`]);
    if (!material) continue;
    if (material.endsWith("(damaged)")) {
      damagedName ??= material;
      continue;
    }
    materials.push({
      quantity: number(recipe.named[`mat${slot}qty`]) ?? 1,
      name: material,
    });
  }

  if (!damagedName) {
    skipped.push(`${name} (no damaged variant)`);
    continue;
  }

  const sources = [
    plain(info?.named.excavationhotspot),
    plain(info?.named.digsite),
  ].filter(Boolean);

  artefacts.push({
    id: slug(name),
    name,
    damagedName,
    level: level ?? number(info?.named.level) ?? 1,
    restoreXp: restoreXp ?? 0,
    chronotes: number(info?.named.chronotes) ?? 0,
    alignment: plain(info?.named.alignment) || "Other",
    sources,
    materials,
  });
}

const byName = new Map(artefacts.map((artefact) => [artefact.name, artefact]));

const collections = [];

for (const name of collectionNames) {
  const text = collectionPages.get(name);
  if (!text) {
    skipped.push(`${name} (collection page not found)`);
    continue;
  }

  const info = templateBodies(text, "Infobox Collection").map(parseTemplate)[0];
  const table = templateBodies(text, "Collections table").map(parseTemplate)[0];
  if (!info || !table) {
    skipped.push(`${name} (collection has no artefact table)`);
    continue;
  }

  const members = table.positional.map(plain).filter((entry) => byName.has(entry));
  if (!members.length) {
    skipped.push(`${name} (no known artefacts)`);
    continue;
  }

  const bonusChronotes =
    number(table.named.collectioncompletionchronotesbonus) ??
    number(info.named.chronotes) ??
    0;

  const recurring = plain(info.named.recurring);
  const recurringReward = recurring
    ? { quantity: number(recurring) ?? 1, name: recurring.replace(/^[\d,]+\s*/, "") }
    : null;

  const alignments = members.map((entry) => byName.get(entry).alignment);
  const collector = plain(info.named.collector) || "Unknown";

  collections.push({
    id: slug(`${name}-${collector}`),
    name,
    collector,
    level: number(info.named.archlevel) ?? 1,
    alignment: alignments.sort(
      (a, b) =>
        alignments.filter((entry) => entry === b).length -
        alignments.filter((entry) => entry === a).length,
    )[0] ?? "Other",
    artefacts: members,
    artefactChronotes: members.reduce(
      (total, entry) => total + byName.get(entry).chronotes,
      0,
    ),
    bonusChronotes,
    restoreXp: Math.round(
      members.reduce((total, entry) => total + byName.get(entry).restoreXp, 0),
    ),
    recurringReward,
    tetracompassPieces: /tetracompass piece/i.test(recurring)
      ? recurringReward?.quantity ?? 1
      : 0,
    oneTimeReward: plain(info.named.relic || info.named.onetime) || null,
  });
}

// Materials are only referenced inside artefact recipes, so derive the catalogue
// from every non-artefact ingredient and record what each one is used for.
const materialUsage = new Map();
for (const artefact of artefacts) {
  for (const material of artefact.materials) {
    const entry = materialUsage.get(material.name) ?? { total: 0, artefacts: 0 };
    entry.total += material.quantity;
    entry.artefacts += 1;
    materialUsage.set(material.name, entry);
  }
}

const materials = [...materialUsage.entries()]
  .map(([name, usage]) => ({
    id: slug(name),
    name,
    usedInArtefacts: usage.artefacts,
    totalQuantity: usage.total,
    // A handful of recipes need world drops (gems, rope) rather than dig materials.
    common: usage.artefacts >= 3,
  }))
  .sort((a, b) => b.usedInArtefacts - a.usedInArtefacts || a.name.localeCompare(b.name));

const payload = {
  source: `https://runescape.wiki/w/${ARTEFACT_LIST}`,
  generatedAt: new Date().toISOString(),
  artefacts,
  collections,
  materials,
};

await mkdir("src/data", { recursive: true });
await writeFile("src/data/archaeology.json", `${JSON.stringify(payload, null, 2)}\n`);

console.log(
  `Synced ${artefacts.length}/${artefactNames.length} artefacts, ` +
    `${collections.length}/${collectionNames.length} collections and ` +
    `${materials.length} materials from the RuneScape Wiki.`,
);
if (skipped.length) console.log(`Skipped:\n  ${skipped.join("\n  ")}`);
