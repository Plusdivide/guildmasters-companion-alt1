/**
 * Grand Exchange prices from the RuneScape Wiki price service
 * (https://prices.runescape.wiki/rs — /api/v2/rs).
 *
 * LocalStorage holds the last successful fetch. Each app session hydrates from
 * that cache for instant tips, then refreshes all material prices once from
 * the wiki and writes them back.
 */
import { archaeologyData, archaeologyMaterials } from "./data";
import type { Artefact } from "./types";

const CACHE_KEY = "rs3-archaeology-companion:ge-prices:v2-wiki";
const WIKI_API = "https://prices.runescape.wiki/api/v2/rs";

type PriceCache = {
  savedAt: number;
  prices: Record<string, number>;
};

const memory = new Map<string, number>();
let loadPromise: Promise<void> | null = null;
let priceVersion = 0;
let diskHydrated = false;
/** True after this page session has finished a wiki refresh attempt. */
let sessionRefreshed = false;

const bumpVersion = (): void => {
  priceVersion += 1;
};

export const getPriceVersion = (): number => priceVersion;

const hydrateFromDisk = (): void => {
  if (diskHydrated) return;
  diskHydrated = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PriceCache;
    if (!parsed?.prices) return;
    let added = 0;
    for (const [name, price] of Object.entries(parsed.prices)) {
      if (typeof price === "number" && price > 0 && !memory.has(name)) {
        memory.set(name, price);
        added += 1;
      }
    }
    if (added) bumpVersion();
  } catch {
    // ignore corrupt cache
  }
};

const writeDiskCache = (): void => {
  const prices: Record<string, number> = {};
  for (const [name, price] of memory) prices[name] = price;
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), prices } satisfies PriceCache),
    );
  } catch {
    // quota / private mode
  }
};

type WikiMappingItem = { id: number; name: string };
type WikiLatestEntry = { high?: number | null; low?: number | null };

/** Prefer instant-buy (high), else sell (low). */
const pickPrice = (entry: WikiLatestEntry | undefined): number | null => {
  if (!entry) return null;
  if (typeof entry.high === "number" && entry.high > 0) return entry.high;
  if (typeof entry.low === "number" && entry.low > 0) return entry.low;
  return null;
};

const wantedMaterialNames = (): Set<string> => {
  const wanted = new Set(archaeologyMaterials().map((material) => material.name));
  for (const artefact of archaeologyData.artefacts) {
    for (const material of artefact.materials) {
      if (!material.name.includes("(damaged)")) wanted.add(material.name);
    }
  }
  return wanted;
};

const fetchWikiPrices = async (): Promise<void> => {
  const [mappingResponse, latestResponse] = await Promise.all([
    fetch(`${WIKI_API}/mapping`, { headers: { Accept: "application/json" } }),
    fetch(`${WIKI_API}/latest`, { headers: { Accept: "application/json" } }),
  ]);
  if (!mappingResponse.ok || !latestResponse.ok) {
    throw new Error(
      `Wiki price request failed (${mappingResponse.status}/${latestResponse.status})`,
    );
  }

  const mapping = (await mappingResponse.json()) as WikiMappingItem[];
  const latestBody = (await latestResponse.json()) as {
    data?: Record<string, WikiLatestEntry>;
  };
  const latest = latestBody.data ?? {};
  const wanted = wantedMaterialNames();

  let changed = 0;
  for (const item of mapping) {
    if (!wanted.has(item.name)) continue;
    const price = pickPrice(latest[String(item.id)]);
    if (price === null) continue;
    if (memory.get(item.name) !== price) {
      memory.set(item.name, price);
      changed += 1;
    }
  }
  if (changed) bumpVersion();
};

/**
 * Hydrate from localStorage, then refresh all material prices from the wiki
 * once per app session and persist them locally.
 */
export const ensureMaterialPrices = async (): Promise<void> => {
  hydrateFromDisk();
  if (sessionRefreshed) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      await fetchWikiPrices();
      writeDiskCache();
    } catch {
      // Keep disk / memory cache if the network fails.
    } finally {
      sessionRefreshed = true;
      loadPromise = null;
    }
  })();

  return loadPromise;
};

/** Fetch / ensure prices, then return one item by exact GE name. */
export const ensurePriceForName = async (name: string): Promise<number | null> => {
  hydrateFromDisk();
  const cached = memory.get(name);
  if (cached !== undefined) {
    void ensureMaterialPrices();
    return cached;
  }
  await ensureMaterialPrices();
  return memory.get(name) ?? null;
};

export const priceForName = (name: string): number | null => {
  hydrateFromDisk();
  return memory.get(name) ?? null;
};

export const materialPrice = (materialId: string): number | null => {
  const material = archaeologyData.materials.find((entry) => entry.id === materialId);
  return material ? priceForName(material.name) : null;
};

/**
 * GE cost to restore one copy. Skips materials with no GE price (untradeable)
 * and returns null only when nothing could be priced.
 */
export const artefactRestoreCost = (artefact: Artefact): number | null => {
  let total = 0;
  let priced = 0;
  for (const material of artefact.materials) {
    if (material.name.includes("(damaged)")) continue;
    const price = priceForName(material.name);
    if (price === null) continue;
    total += price * material.quantity;
    priced += 1;
  }
  return priced ? total : null;
};

export const formatGp = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 10_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(
    Math.round(value),
  );
};
