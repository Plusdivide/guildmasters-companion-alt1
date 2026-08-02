/**
 * Grand Exchange prices for archaeology dig materials (and damaged artefacts
 * when tradeable), via Weird Gloop’s RS3 exchange API.
 */
import { archaeologyData, archaeologyMaterials } from "./data";

const CACHE_KEY = "rs3-archaeology-companion:ge-prices:v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BATCH = 40;

type PriceCache = {
  savedAt: number;
  prices: Record<string, number>;
};

const memory = new Map<string, number>();
let loadPromise: Promise<void> | null = null;

const apiBase = (): string => {
  // Dev proxy avoids CORS / TLS quirks; production hits Weird Gloop directly.
  if (typeof location !== "undefined" && /127\.0\.0\.1|localhost/.test(location.hostname)) {
    return "/ge-price";
  }
  return "https://api.weirdgloop.org/exchange/history/rs/latest";
};

const readDiskCache = (): void => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PriceCache;
    if (!parsed?.prices || Date.now() - parsed.savedAt > CACHE_TTL_MS) return;
    for (const [name, price] of Object.entries(parsed.prices)) {
      if (typeof price === "number" && price > 0) memory.set(name, price);
    }
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

const fetchBatch = async (names: string[]): Promise<void> => {
  if (!names.length) return;
  const query = names.map(encodeURIComponent).join("%7C");
  const url = `${apiBase()}?name=${query}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return;
  const body = (await response.json()) as Record<
    string,
    { price?: number } | { success?: false }
  >;
  for (const name of names) {
    const entry = body[name];
    if (entry && "price" in entry && typeof entry.price === "number" && entry.price > 0) {
      memory.set(name, entry.price);
    }
  }
};

/** Load GE prices for all dig materials (cached ~6h). */
export const ensureMaterialPrices = async (): Promise<void> => {
  if (!memory.size) readDiskCache();
  if (loadPromise) return loadPromise;

  const names = archaeologyMaterials().map((material) => material.name);
  const missing = names.filter((name) => !memory.has(name));
  if (!missing.length) return;

  loadPromise = (async () => {
    try {
      for (let index = 0; index < missing.length; index += BATCH) {
        await fetchBatch(missing.slice(index, index + BATCH));
      }
      writeDiskCache();
    } catch {
      // Keep whatever we already had cached.
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
};

/** Fetch a single item by exact GE name if not cached. */
export const ensurePriceForName = async (name: string): Promise<number | null> => {
  if (!memory.size) readDiskCache();
  const cached = memory.get(name);
  if (cached !== undefined) return cached;
  try {
    await fetchBatch([name]);
    writeDiskCache();
  } catch {
    return null;
  }
  return memory.get(name) ?? null;
};

export const priceForName = (name: string): number | null => {
  if (!memory.size) readDiskCache();
  return memory.get(name) ?? null;
};

export const materialPrice = (materialId: string): number | null => {
  const material = archaeologyData.materials.find((entry) => entry.id === materialId);
  return material ? priceForName(material.name) : null;
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
