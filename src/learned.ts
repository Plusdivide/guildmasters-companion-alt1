// Sprites the user has taught from their own screen. These are captured from
// the live client, so they match subsequent scans far better than wiki art,
// which is a separate render of the same model. Stored apart from PlayerState
// because the PNG data URLs are comparatively large.

const STORAGE_KEY = "rs3-archaeology-companion:learned:v1";

export type LearnedSprites = Record<string, string>;

export type LearnedKey =
  | { type: "artefact"; id: string; kind: "damaged" | "restored" }
  | { type: "material"; id: string };

export const artefactLearnedKey = (
  id: string,
  kind: "damaged" | "restored",
): string => `art:${id}:${kind}`;

export const materialLearnedKey = (id: string): string => `mat:${id}`;

export const parseLearnedKey = (key: string): LearnedKey | null => {
  if (key.startsWith("art:")) {
    const rest = key.slice(4);
    const split = rest.lastIndexOf(":");
    if (split < 0) return null;
    const id = rest.slice(0, split);
    const kind = rest.slice(split + 1);
    if (kind !== "damaged" && kind !== "restored") return null;
    return { type: "artefact", id, kind };
  }
  if (key.startsWith("mat:")) {
    return { type: "material", id: key.slice(4) };
  }
  return null;
};

export const loadLearned = (): LearnedSprites => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as LearnedSprites) : {};
  } catch {
    return {};
  }
};

const persist = (sprites: LearnedSprites): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sprites));
};

export const saveLearnedSprite = (key: string, dataUrl: string): void => {
  const sprites = loadLearned();
  sprites[key] = dataUrl;
  persist(sprites);
};

export const removeLearnedSprite = (key: string): void => {
  const sprites = loadLearned();
  delete sprites[key];
  persist(sprites);
};

export const clearLearned = (): void => {
  localStorage.removeItem(STORAGE_KEY);
};

export const learnedCount = (): number => Object.keys(loadLearned()).length;
