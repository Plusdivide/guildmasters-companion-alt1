import rawData from "./data/archaeology.json";
import spriteManifest from "./data/sprites.json";
import type {
  ArchaeologyData, Artefact, Collection, MaterialInfo, PlayerState, TetraPieceId,
} from "./types";
import { getCount } from "./store";

export const archaeologyData = rawData as ArchaeologyData;
export const artefactsByName = new Map(
  archaeologyData.artefacts.map((artefact) => [artefact.name, artefact]),
);

export const sprites = spriteManifest as {
  artefacts: Record<string, { damaged?: string; restored?: string }>;
  materials: Record<string, string>;
  ui: Record<string, string>;
};

const base = import.meta.env.BASE_URL;

// Every icon ships with the app so nothing is fetched from the wiki at runtime.
export const uiIcon = (key: string): string => `${base}ui/${sprites.ui[key] ?? "archaeology.png"}`;

export const artefactIcon = (id: string, kind: "damaged" | "restored" = "restored"): string => {
  const file = sprites.artefacts[id]?.[kind] ?? sprites.artefacts[id]?.restored;
  return file ? `${base}sprites/${file}` : uiIcon("archaeology");
};

export const materialIcon = (id: string): string => {
  const file = sprites.materials[id];
  return file ? `${base}sprites/${file}` : uiIcon("materials");
};

/** Tetracompass piece sprites ship beside materials (not in sprites.json). */
export const tetraPieceIcon = (id: TetraPieceId): string =>
  `${base}sprites/tetracompass-piece-${id}.png`;

export const tetraPieceLabel = (id: TetraPieceId): string =>
  `Tetracompass piece (${id})`;

// Tradeable / shop items the workbench asks for that are not dug up at a site.
// Kept out of the materials log and out of bank/material scans — this app only
// tracks archaeology-exclusive dig materials.
const OFF_SITE_MATERIALS = new Set([
  "Diamond", "Ruby", "Sapphire", "Emerald", "Dragonstone", "Molten glass",
  "Bronze bar", "Silver bar", "Rope", "Clockwork", "Phoenix feather",
  "Death rune", "White candle", "Weapon poison (3)",
  // Also used in a few restorations, but obtained outside Archaeology digs.
  "Black mushroom ink", "Grapes", "Soft clay",
]);

export const COMMON_MATERIALS_LABEL = "Common materials";
export const OFF_SITE_MATERIALS_LABEL = "Other items";

/** Dig-site / cache materials only — not gems, bars, ink, clay, etc. */
export const isArchaeologyMaterial = (material: MaterialInfo): boolean =>
  !OFF_SITE_MATERIALS.has(material.name);

/** Archaeology materials shown in the materials log and accepted by scans. */
export const archaeologyMaterials = (): MaterialInfo[] =>
  archaeologyData.materials.filter(isArchaeologyMaterial);

const alignmentsByMaterial = ((): Map<string, Map<string, number>> => {
  const usage = new Map<string, Map<string, number>>();
  for (const artefact of archaeologyData.artefacts) {
    for (const material of artefact.materials) {
      if (material.name.includes("(damaged)")) continue;
      const counts = usage.get(material.name) ?? new Map<string, number>();
      counts.set(artefact.alignment, (counts.get(artefact.alignment) ?? 0) + 1);
      usage.set(material.name, counts);
    }
  }
  return usage;
})();

// Materials wanted by three or more cultures are shared rather than themed.
export const materialCategory = (material: MaterialInfo): string => {
  if (!isArchaeologyMaterial(material)) return OFF_SITE_MATERIALS_LABEL;
  const counts = alignmentsByMaterial.get(material.name);
  if (!counts?.size) return OFF_SITE_MATERIALS_LABEL;
  if (counts.size >= 3) return COMMON_MATERIALS_LABEL;
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0][0];
};

/** Dig sites / areas where a material is typically excavated. */
const PRIMARY_DIG_SITES = new Set([
  "Kharid-et",
  "Everlight",
  "Infernal Source",
  "Orthen",
  "Warforge",
  "Stormguard Citadel",
  "Senntisten",
  "Daemonheim",
  "Moonrise",
  "Moonrise Dig Site",
  "Archaeology Guild",
]);

const ALIGNMENT_DIG_SITE: Record<string, string> = {
  Zarosian: "Kharid-et",
  Zamorakian: "Infernal Source",
  Saradominist: "Everlight",
  Armadylean: "Stormguard Citadel",
  Bandosian: "Warforge",
  Dragonkin: "Orthen",
  Guthixian: "Moonrise Dig Site",
  Miscellaneous: "Archaeology Guild",
};

const digSitesByMaterial = ((): Map<string, string[]> => {
  const sites = new Map<string, Set<string>>();
  for (const artefact of archaeologyData.artefacts) {
    for (const material of artefact.materials) {
      if (material.name.includes("(damaged)")) continue;
      const set = sites.get(material.name) ?? new Set<string>();
      for (const source of artefact.sources) {
        if (PRIMARY_DIG_SITES.has(source)) set.add(source === "Moonrise" ? "Moonrise Dig Site" : source);
      }
      sites.set(material.name, set);
    }
  }
  return new Map(
    [...sites.entries()].map(([name, set]) => [name, [...set].sort((a, b) => a.localeCompare(b))]),
  );
})();

/** Where to excavate this material (dig sites). */
export const materialFindSites = (material: MaterialInfo): string[] => {
  const known = digSitesByMaterial.get(material.name);
  if (known?.length) return known;
  const category = materialCategory(material);
  if (category === COMMON_MATERIALS_LABEL) {
    return ["Most dig sites"];
  }
  const site = ALIGNMENT_DIG_SITE[category];
  return site ? [site] : [];
};

export interface CollectionProgress {
  collection: Collection;
  completeSets: number;
  restoredSets: number;
  potentialSets: number;
  missing: { artefact: Artefact; quantity: number }[];
  totalChronotes: number;
  totalTetracompassPieces: number;
  pendingRestoreXp: number;
  /** Materials needed to restore owned unrestored sets (aggregated). */
  restoreMaterials: { name: string; quantity: number }[];
  score: number;
}

export const getCollectionProgress = (
  collection: Collection,
  state: PlayerState,
): CollectionProgress => {
  const entries = collection.artefacts
    .map((name) => artefactsByName.get(name))
    .filter((artefact): artefact is Artefact => Boolean(artefact));

  const restoredSets = entries.length
    ? Math.min(...entries.map((artefact) => getCount(state, artefact.id).restored))
    : 0;
  const potentialSets = entries.length
    ? Math.min(
        ...entries.map((artefact) => {
          const count = getCount(state, artefact.id);
          return count.restored + count.damaged;
        }),
      )
    : 0;

  const missing = entries
    .map((artefact) => ({
      artefact,
      quantity: Math.max(0, 1 - getCount(state, artefact.id).restored),
    }))
    .filter((entry) => entry.quantity > 0);

  const pendingRestoreXp = entries.reduce(
    (total, artefact) => total + getCount(state, artefact.id).damaged * artefact.restoreXp,
    0,
  );

  // Materials to restore enough damaged pieces so every owned set is restored.
  const materialTotals = new Map<string, number>();
  for (const artefact of entries) {
    const count = getCount(state, artefact.id);
    const shortfall = Math.max(0, potentialSets - count.restored);
    const toRestore = Math.min(count.damaged, shortfall);
    if (!toRestore) continue;
    for (const material of artefact.materials) {
      materialTotals.set(
        material.name,
        (materialTotals.get(material.name) ?? 0) + material.quantity * toRestore,
      );
    }
  }
  const restoreMaterials = [...materialTotals.entries()]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));

  const totalChronotes =
    potentialSets * (collection.artefactChronotes + collection.bonusChronotes);
  const totalTetracompassPieces = potentialSets * collection.tetracompassPieces;
  // Inventory-oriented score for "sets you already own" lists — not used for
  // recommending what to excavate next.
  const score =
    totalChronotes +
    totalTetracompassPieces * 50000 +
    (potentialSets > 0 ? 5000 : 0) -
    missing.length * 100;

  return {
    collection,
    completeSets: potentialSets,
    restoredSets,
    potentialSets,
    missing,
    totalChronotes,
    totalTetracompassPieces,
    pendingRestoreXp,
    restoreMaterials,
    score,
  };
};

// Rough chronote value of one tetracompass piece so tetra farms can compete with
// chronote farms in a single ranking. Community money guides put a piece well
// above a few thousand chronotes.
const TETRA_CHRONOTE_EQUIVALENT = 12000;

// Tutorial / non-repeatable turn-ins that inflate "best" lists if left in.
const EXCLUDED_FROM_OPPORTUNITIES = new Set([
  "Museum - Training Weapons",
  "Desperate for Artefacts",
]);

// RuneHQ / wiki meta for chronotes-per-hour by Archaeology level. Prefer the
// Museum (Velucia) copy when it exists — same dig, higher chronote bonus.
const CHRONOTE_META_BY_LEVEL: { minLevel: number; names: string[] }[] = [
  { minLevel: 25, names: ["Museum - Zarosian I", "Zarosian I"] },
  { minLevel: 36, names: ["Museum - Zamorakian I", "Zamorakian I"] },
  { minLevel: 56, names: ["Museum - Saradominist I", "Saradominist I"] },
  { minLevel: 72, names: ["Museum - Saradominist II", "Saradominist II"] },
  { minLevel: 81, names: ["Museum - Zamorakian II", "Zamorakian II"] },
  { minLevel: 89, names: ["Museum - Bandosian I"] },
  { minLevel: 98, names: ["Museum - Armadylean II", "Armadylean II"] },
  { minLevel: 100, names: ["Museum - Bandosian II"] },
  { minLevel: 104, names: ["Museum - Zamorakian III", "Zamorakian III"] },
  { minLevel: 107, names: ["Museum - Zarosian III", "Zarosian III"] },
  { minLevel: 116, names: ["Museum - Zamorakian IV", "Zamorakian IV"] },
  { minLevel: 117, names: ["Museum - Saradominist IV", "Saradominist IV"] },
  { minLevel: 118, names: ["Museum - Armadylean III", "Armadylean III"] },
  { minLevel: 119, names: ["Museum - Zarosian IV", "Zarosian IV"] },
];

// Fastest tetracompass-piece farms (few artefacts, few hotspots).
const TETRA_META_BY_LEVEL: { minLevel: number; names: string[] }[] = [
  { minLevel: 83, names: ["Green Gobbo Goodies I"] },
  { minLevel: 94, names: ["Red Rum Relics I", "Green Gobbo Goodies I"] },
  { minLevel: 97, names: ["Red Rum Relics I", "Green Gobbo Goodies II"] },
  { minLevel: 110, names: ["Red Rum Relics II", "Red Rum Relics I"] },
  { minLevel: 119, names: ["Red Rum Relics III", "Green Gobbo Goodies III"] },
];

const digCost = (collection: Collection): number => {
  const levels = collection.artefacts
    .map((name) => artefactsByName.get(name)?.level ?? collection.level)
    .filter((level) => level > 0);
  // Sum of artefact levels is the community "speed value": more / higher-level
  // pieces take longer to dig. Fall back to requirement × count.
  const sum = levels.reduce((total, level) => total + level, 0);
  return Math.max(1, sum || collection.level * Math.max(1, collection.artefacts.length));
};

const rewardValue = (collection: Collection): number =>
  collection.artefactChronotes +
  collection.bonusChronotes +
  collection.tetracompassPieces * TETRA_CHRONOTE_EQUIVALENT;

/** Estimated reward density — higher is better chronotes/tetra per dig time. */
export const collectionEfficiency = (collection: Collection): number =>
  rewardValue(collection) / digCost(collection);

const isOpportunityCandidate = (collection: Collection, level: number): boolean => {
  if (collection.level > level) return false;
  if (EXCLUDED_FROM_OPPORTUNITIES.has(collection.name)) return false;
  // One-off turn-ins with no real recurring reward.
  if (collection.recurringReward?.name === "No" && collection.tetracompassPieces === 0) {
    return false;
  }
  return true;
};

const pickNamed = (names: string[], level: number): Collection | null => {
  for (const name of names) {
    const match = archaeologyData.collections.find(
      (collection) => collection.name === name && collection.level <= level,
    );
    if (match && isOpportunityCandidate(match, level)) return match;
  }
  return null;
};

const metaForLevel = (
  bands: { minLevel: number; names: string[] }[],
  level: number,
): Collection | null => {
  let best: { minLevel: number; names: string[] } | null = null;
  for (const band of bands) {
    if (band.minLevel <= level && (!best || band.minLevel >= best.minLevel)) {
      best = band;
    }
  }
  return best ? pickNamed(best.names, level) : null;
};

// Keep the highest-paying copy when Museum and digsite collectors share artefacts.
const dedupeByArtefacts = (collections: Collection[]): Collection[] => {
  const best = new Map<string, Collection>();
  for (const collection of collections) {
    const key = [...collection.artefacts].sort().join("\0");
    const existing = best.get(key);
    if (!existing || rewardValue(collection) > rewardValue(existing)) {
      best.set(key, collection);
    }
  }
  return [...best.values()];
};

export interface CollectionOpportunity {
  progress: CollectionProgress;
  // Which reward lane this row represents on the Overview.
  reason: "chronotes" | "tetracompass" | "other";
  // Short label shown in the card, e.g. "Best for chronotes".
  label: string;
}

const PYLON_META_BY_LEVEL: { minLevel: number; names: string[] }[] = [
  { minLevel: 25, names: ["Zarosian I"] },
  { minLevel: 81, names: ["Zarosian II"] },
  { minLevel: 107, names: ["Zarosian III"] },
];

const DUNG_META_BY_LEVEL: { minLevel: number; names: string[] }[] = [
  // Dragonkin V is the community dung-token farm (2 large boxes, 4 artefacts).
  { minLevel: 77, names: ["Dragonkin V"] },
];

const ROBUST_GLASS_META_BY_LEVEL: { minLevel: number; names: string[] }[] = [
  { minLevel: 69, names: ["Blingy Fings"] },
  { minLevel: 81, names: ["Smoky Fings"] },
  { minLevel: 89, names: ["Hitty Fings"] },
  { minLevel: 92, names: ["Showy Fings"] },
];

const otherRewardPick = (
  level: number,
): { collection: Collection; label: string } | null => {
  const dung = metaForLevel(DUNG_META_BY_LEVEL, level);
  if (dung) {
    return { collection: dung, label: "Best for dung tokens" };
  }
  const pylon = metaForLevel(PYLON_META_BY_LEVEL, level);
  if (pylon) {
    return { collection: pylon, label: "Best for pylon batteries" };
  }
  const glass = metaForLevel(ROBUST_GLASS_META_BY_LEVEL, level);
  if (glass) {
    return { collection: glass, label: "Best for robust glass" };
  }
  return null;
};

/**
 * Three recommended farms for this Archaeology level: chronotes pace, tetra
 * pace, and one other recurring reward (dung tokens when unlocked, otherwise
 * pylon batteries / robust glass).
 */
export const bestCollectionOpportunities = (
  state: PlayerState,
): CollectionOpportunity[] => {
  const level = Math.max(1, Math.min(120, state.level));
  const chronote = metaForLevel(CHRONOTE_META_BY_LEVEL, level);
  const tetra = metaForLevel(TETRA_META_BY_LEVEL, level);
  const other = otherRewardPick(level);

  const rows: CollectionOpportunity[] = [];
  const used = new Set<string>();

  const push = (
    collection: Collection | null,
    reason: CollectionOpportunity["reason"],
    label: string,
  ): void => {
    if (!collection || used.has(collection.id)) return;
    used.add(collection.id);
    rows.push({
      progress: getCollectionProgress(collection, state),
      reason,
      label,
    });
  };

  push(chronote, "chronotes", "Best for chronotes");
  push(tetra, "tetracompass", "Best for tetracompass");
  push(other?.collection ?? null, "other", other?.label ?? "Best other reward");

  // If meta lanes collided (same collection) or a lane was missing, fill from
  // efficiency so the Overview still shows up to three distinct picks.
  if (rows.length < 3) {
    const fillers = dedupeByArtefacts(
      archaeologyData.collections.filter((collection) =>
        isOpportunityCandidate(collection, level),
      ),
    )
      .map((collection) => ({
        collection,
        efficiency: collectionEfficiency(collection),
      }))
      .sort((a, b) => b.efficiency - a.efficiency);

    for (const fill of fillers) {
      if (rows.length >= 3) break;
      if (used.has(fill.collection.id)) continue;
      const reason: CollectionOpportunity["reason"] =
        fill.collection.tetracompassPieces > 0 ? "tetracompass" : "chronotes";
      push(
        fill.collection,
        reason,
        reason === "tetracompass" ? "Strong tetracompass pace" : "Strong chronotes pace",
      );
    }
  }

  return rows;
};

export const formatNumber = (value: number): string =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);
