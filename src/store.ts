import type { InventoryCount, PlayerState } from "./types";

const STORAGE_KEY = "rs3-archaeology-companion:v1";

const initialState: PlayerState = {
  displayName: "",
  level: 1,
  xp: 0,
  theme: "classic",
  compact: true,
  debugScanOverlay: false,
  debugOverlayWidth: 1,
  debugStitchPreview: false,
  advancedMatching: false,
  entryMode: "auto",
  setupComplete: false,
  inventory: {},
  materials: {},
  completedCollections: [],
  favoriteCollections: [],
  lastScanAt: null,
};

export const loadState = (): PlayerState => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(initialState);
    const parsed = JSON.parse(stored) as Partial<PlayerState>;
    return {
      ...initialState,
      ...parsed,
      favoriteCollections: Array.isArray(parsed.favoriteCollections)
        ? parsed.favoriteCollections
        : [],
    };
  } catch {
    return structuredClone(initialState);
  }
};

// Writes happen on every quantity tweak, so they are coalesced into one frame.
let saveTimer: number | undefined;

export const saveState = (state: PlayerState): void => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, 120);
};

export const saveStateNow = (state: PlayerState): void => {
  window.clearTimeout(saveTimer);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

export const getCount = (state: PlayerState, id: string): InventoryCount =>
  state.inventory[id] ?? { damaged: 0, restored: 0 };

export const setCount = (
  state: PlayerState,
  id: string,
  kind: keyof InventoryCount,
  value: number,
): number => {
  const clamped = Math.max(0, Math.floor(value || 0));
  state.inventory[id] = { ...getCount(state, id), [kind]: clamped };
  saveState(state);
  return clamped;
};

export const getMaterial = (state: PlayerState, id: string): number => state.materials[id] ?? 0;

export const setMaterial = (state: PlayerState, id: string, value: number): number => {
  const clamped = Math.max(0, Math.floor(value || 0));
  state.materials[id] = clamped;
  saveState(state);
  return clamped;
};

export const exportState = (state: PlayerState): void => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `archaeology-companion-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
};

export const importState = async (file: File): Promise<PlayerState> => {
  const parsed = JSON.parse(await file.text()) as Partial<PlayerState>;
  const state = {
    ...initialState,
    ...parsed,
    favoriteCollections: Array.isArray(parsed.favoriteCollections)
      ? parsed.favoriteCollections
      : [],
  } as PlayerState;
  saveStateNow(state);
  return state;
};
