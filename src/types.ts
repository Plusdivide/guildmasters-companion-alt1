export interface Material {
  quantity: number;
  name: string;
}

export interface Artefact {
  id: string;
  name: string;
  damagedName: string;
  level: number;
  restoreXp: number;
  chronotes: number;
  alignment: string;
  sources: string[];
  materials: Material[];
}

export interface Collection {
  id: string;
  name: string;
  collector: string;
  level: number;
  alignment: string;
  artefacts: string[];
  artefactChronotes: number;
  bonusChronotes: number;
  restoreXp: number;
  recurringReward: Material | null;
  tetracompassPieces: number;
  oneTimeReward: string | null;
}

export interface MaterialInfo {
  id: string;
  name: string;
  usedInArtefacts: number;
  totalQuantity: number;
  common: boolean;
}

export interface ArchaeologyData {
  source: string;
  generatedAt: string;
  artefacts: Artefact[];
  collections: Collection[];
  materials: MaterialInfo[];
}

export interface InventoryCount {
  damaged: number;
  restored: number;
}

export type ThemeName = "classic" | "stone" | "dark" | "midnight";
export type EntryMode = "auto" | "manual";

export type ScanWizardInterface = "bank" | "material-storage" | "workbench";

export interface ScanWizardDone {
  bank: boolean;
  "material-storage": boolean;
  workbench: boolean;
}

/** Tetracompass dig pieces — tracker only, not a wiki collection. */
export type TetraPieceId = "left" | "right" | "dial" | "needle";

export type TetraPieceCounts = Record<TetraPieceId, number>;

export const TETRA_PIECE_IDS: TetraPieceId[] = [
  "left",
  "right",
  "dial",
  "needle",
];

export const emptyTetraPieces = (): TetraPieceCounts => ({
  left: 0,
  right: 0,
  dial: 0,
  needle: 0,
});

export interface PlayerState {
  displayName: string;
  level: number;
  xp: number;
  theme: ThemeName;
  compact: boolean;
  entryMode: EntryMode;
  setupComplete: boolean;
  /** Finished or skipped the first-run Bank → Material Storage → Workbench walkthrough. */
  scanWizardComplete: boolean;
  /** Which storage scans were saved during (or before) the wizard. */
  scanWizardDone: ScanWizardDone;
  inventory: Record<string, InventoryCount>;
  materials: Record<string, number>;
  /** Owned tetracompass pieces from digs / Luck — not a collection set. */
  tetraPieces: TetraPieceCounts;
  completedCollections: string[];
  // Collection ids the player pinned from the Collections tab.
  favoriteCollections: string[];
  lastScanAt: string | null;
  /**
   * Developer tools (watcher card, outlines). Only meaningful when
   * ENABLE_DEV_TOOLS is true; ignored in public builds.
   */
  devMode: boolean;
}

export type ViewName =
  | "dashboard"
  | "inventory"
  | "collections"
  | "scan"
  | "settings";
