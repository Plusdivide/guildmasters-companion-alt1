import type { Artefact } from "./types";

declare global {
  interface Window {
    alt1?: {
      permissionPixel: boolean;
      permissionGameState: boolean;
      permissionInstalled: boolean;
      rsLinked: boolean;
      rsWidth?: number;
      rsHeight?: number;
      rsScaling?: number;
      rsActive?: boolean;
      compatEnabled?: boolean;
      identifyAppUrl: (url: string) => unknown;
      /**
       * Register a global function name for on-screen XP-rise events.
       * Requires Gamestate permission. Pass "" to clear.
       */
      xpRiseListener?: (callback: string) => boolean;
      bindRegion?: (x: number, y: number, w: number, h: number) => number;
      bindReadColorString?: (
        id: number,
        fontname: string,
        color: number,
        x: number,
        y: number,
      ) => string;
      bindReadStringEx?: (
        id: number,
        x: number,
        y: number,
        args: string,
      ) => string;
      bindReadString?: (
        id: number,
        fontname: string,
        x: number,
        y: number,
      ) => string;
    };
  }
}

export interface ScanStatus {
  available: boolean;
  linked: boolean;
  pixelPermission: boolean;
  gameStatePermission: boolean;
  message: string;
}

export const getAlt1Status = (): ScanStatus => {
  if (!window.alt1) {
    return {
      available: false,
      linked: false,
      pixelPermission: false,
      gameStatePermission: false,
      message: "Open this app inside Alt1 to enable screen scanning.",
    };
  }

  const linked = window.alt1.rsLinked;
  const pixelPermission = Boolean(window.alt1.permissionPixel);
  const gameStatePermission = Boolean(window.alt1.permissionGameState);

  if (!pixelPermission) {
    return {
      available: true,
      linked,
      pixelPermission: false,
      gameStatePermission,
      message:
        "Enable “View screen” in Alt1’s app settings (spanner → permissions).",
    };
  }

  if (!gameStatePermission) {
    return {
      available: true,
      linked,
      pixelPermission: true,
      gameStatePermission: false,
      message: linked
        ? "Scans ready. Enable “Get game state” so teach can track the mouse."
        : "Enable “Get game state”, and link the RuneScape client.",
    };
  }

  return {
    available: true,
    linked,
    pixelPermission: true,
    gameStatePermission: true,
    message: linked
      ? "Alt1 is linked and ready for guided scans."
      : "Alt1 is open, but the RuneScape client is not linked.",
  };
};

/**
 * Tells Alt1 which app this page is, so it can be added from the Alt1 browser.
 *
 * Only worth doing when the page is not already running as the installed app:
 * identifying from inside the app window makes Alt1 re-resolve the window
 * against its bookmark list, which is what closes and reopens it.
 */
export const identifyAlt1App = (): void => {
  if (!window.alt1 || window.alt1.permissionInstalled) return;
  window.alt1.identifyAppUrl(new URL("appconfig.json", window.location.href).href);
};

// Recognition is deliberately isolated here. It only reads pixels and never sends
// mouse or keyboard input to RuneScape. Interface-specific image references will be
// calibrated against screenshots before automatic quantity writes are enabled.
const normalizeArtefactNeedle = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\(damaged\)/gi, "damaged")
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const compactArtefactNeedle = (text: string): string =>
  normalizeArtefactNeedle(text).replace(/ /g, "");

export const matchArtefactText = (text: string, artefacts: Artefact[]): Artefact | null => {
  const normalized = normalizeArtefactNeedle(text);
  const compact = compactArtefactNeedle(text);
  if (normalized.length < 4 && compact.length < 4) return null;

  // Prefer the longest name hit so short substrings don't steal the match.
  // Also compare space-stripped forms — dig OCR often inserts 1px letter gaps as spaces.
  let best: Artefact | null = null;
  let bestLen = 0;
  for (const artefact of artefacts) {
    const restored = normalizeArtefactNeedle(artefact.name);
    const damaged = normalizeArtefactNeedle(artefact.damagedName);
    const restoredC = restored.replace(/ /g, "");
    const damagedC = damaged.replace(/ /g, "");
    if (
      (normalized.includes(damaged) || compact.includes(damagedC)) &&
      damagedC.length > bestLen
    ) {
      best = artefact;
      bestLen = damagedC.length;
    } else if (
      (normalized.includes(restored) || compact.includes(restoredC)) &&
      restoredC.length > bestLen
    ) {
      best = artefact;
      bestLen = restoredC.length;
    }
  }
  return best;
};
