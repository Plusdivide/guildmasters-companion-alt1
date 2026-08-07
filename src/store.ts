import type {
  InventoryCount,
  PlayerState,
  ScanWizardDone,
  TetraPieceCounts,
  TetraPieceId,
} from "./types";
import { emptyTetraPieces, TETRA_PIECE_IDS } from "./types";

const STORAGE_KEY = "rs3-archaeology-companion:v1";

/**
 * When true, player state is never written to localStorage and loads as a fresh install.
 * Keep false so both `npm run dev` and production builds persist across restarts.
 * Do NOT ship a hard-coded `true` on main — see docs/PUBLISH.md.
 */
const DISCARD_PLAYER_STATE_ON_CLOSE = false;

const emptyWizardDone = (): ScanWizardDone => ({
  bank: false,
  "material-storage": false,
  workbench: false,
});

const normalizeTetraPieces = (
  raw: Partial<TetraPieceCounts> | undefined,
): TetraPieceCounts => {
  const next = emptyTetraPieces();
  if (!raw || typeof raw !== "object") return next;
  for (const id of TETRA_PIECE_IDS) {
    const value = raw[id];
    if (typeof value === "number" && Number.isFinite(value)) {
      next[id] = Math.max(0, Math.floor(value));
    }
  }
  return next;
};

const initialState: PlayerState = {
  displayName: "",
  level: 1,
  xp: 0,
  theme: "classic",
  compact: true,
  entryMode: "auto",
  setupComplete: false,
  scanWizardComplete: false,
  scanWizardDone: emptyWizardDone(),
  inventory: {},
  materials: {},
  tetraPieces: emptyTetraPieces(),
  completedCollections: [],
  favoriteCollections: [],
  lastScanAt: null,
  devMode: false,
};

const normalizeState = (parsed: Partial<PlayerState>): PlayerState => {
  const done = parsed.scanWizardDone;
  const scanWizardDone: ScanWizardDone = {
    bank: Boolean(done?.bank),
    "material-storage": Boolean(done?.["material-storage"]),
    workbench: Boolean(done?.workbench),
  };
  // Existing saves: anyone who already scanned skips the new wizard.
  const scanWizardComplete =
    typeof parsed.scanWizardComplete === "boolean"
      ? parsed.scanWizardComplete
      : Boolean(parsed.lastScanAt);

  return {
    ...initialState,
    ...parsed,
    favoriteCollections: Array.isArray(parsed.favoriteCollections)
      ? parsed.favoriteCollections
      : [],
    tetraPieces: normalizeTetraPieces(parsed.tetraPieces),
    scanWizardDone,
    scanWizardComplete,
    devMode: Boolean(parsed.devMode),
  };
};

export const loadState = (): PlayerState => {
  if (DISCARD_PLAYER_STATE_ON_CLOSE) {
    return structuredClone(initialState);
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(initialState);
    return normalizeState(JSON.parse(stored) as Partial<PlayerState>);
  } catch {
    return structuredClone(initialState);
  }
};

// Writes happen on every quantity tweak, so they are coalesced into one frame.
let saveTimer: number | undefined;

export const saveState = (state: PlayerState): void => {
  if (DISCARD_PLAYER_STATE_ON_CLOSE) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, 120);
};

export const saveStateNow = (state: PlayerState): void => {
  if (DISCARD_PLAYER_STATE_ON_CLOSE) {
    window.clearTimeout(saveTimer);
    return;
  }
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

export const getTetraPiece = (state: PlayerState, id: TetraPieceId): number =>
  state.tetraPieces[id] ?? 0;

export const setTetraPiece = (
  state: PlayerState,
  id: TetraPieceId,
  value: number,
): number => {
  const clamped = Math.max(0, Math.floor(value || 0));
  state.tetraPieces[id] = clamped;
  saveState(state);
  return clamped;
};

/** How many complete tetracompasses can be assembled from current pieces. */
export const tetraCompassesReady = (state: PlayerState): number =>
  Math.min(...TETRA_PIECE_IDS.map((id) => getTetraPiece(state, id)));

/** Spend one of each piece (after the player assembles in-game). */
export const assembleTetraCompass = (state: PlayerState): boolean => {
  if (tetraCompassesReady(state) < 1) return false;
  for (const id of TETRA_PIECE_IDS) {
    state.tetraPieces[id] = getTetraPiece(state, id) - 1;
  }
  saveState(state);
  return true;
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
  const next = normalizeState(parsed);
  saveStateNow(next);
  return next;
};

export const resetScanWizardProgress = (state: PlayerState): void => {
  state.scanWizardComplete = false;
  state.scanWizardDone = emptyWizardDone();
};
