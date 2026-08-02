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

export interface PlayerState {
  displayName: string;
  level: number;
  xp: number;
  theme: ThemeName;
  compact: boolean;
  entryMode: EntryMode;
  setupComplete: boolean;
  inventory: Record<string, InventoryCount>;
  materials: Record<string, number>;
  completedCollections: string[];
  // Collection ids the player pinned from the Collections tab.
  favoriteCollections: string[];
  lastScanAt: string | null;
}

export type ViewName =
  | "dashboard"
  | "inventory"
  | "collections"
  | "scan"
  | "settings";
