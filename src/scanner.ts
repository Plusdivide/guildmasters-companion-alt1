import * as a1lib from "alt1/base";
import * as OCR from "alt1/ocr";
import digitFont from "alt1/fonts/pixel_8px_digits.js";
import { archaeologyData, isArchaeologyMaterial, sprites } from "./data";
import {
  artefactLearnedKey,
  loadLearned,
  materialLearnedKey,
  parseLearnedKey,
} from "./learned";
import { isIgnored, loadIgnored } from "./ignored";
import {
  fitStrength,
  judgeFit,
  measureFit,
  prepareSprite,
  rankOf,
  readSlot,
  roughlyFits,
  TRUSTED_SOFT_PRECISION,
  type Fit,
  type MatchSprite,
  type SlotContent,
} from "./matcher";
import { matchBankStorageStitch } from "./bank-stitch-match";
import { matchMaterialStorageStitch } from "./material-stitch-match";
import { matchWorkbenchStorageStitch } from "./workbench-stitch-match";
import type { Artefact, MaterialInfo } from "./types";

export type ScanMode = "artefacts" | "materials" | "both";
export type ScanInterface = "bank" | "workbench" | "material-storage";

export interface ArtefactHit {
  type: "artefact";
  artefact: Artefact;
  kind: "damaged" | "restored";
  quantity: number;
  // Whether the pixels agreed outright rather than being accepted as a redrawn
  // icon. A scroll session uses this to tell a certain reading from one that
  // wants corroborating before it is counted.
  exact: boolean;
  // Untrusted in a scroll session: clipped top/bottom row, or a weak soft match
  // while the list was moving. Session merge drops these unless another pass
  // corroborates them (or they were exact / strong soft ≥88%).
  edgeRow: boolean;
}

export interface MaterialHit {
  type: "material";
  material: MaterialInfo;
  quantity: number;
  exact: boolean;
  // Same meaning as ArtefactHit.edgeRow — untrusted scroll reading.
  edgeRow: boolean;
}

export type ScanHit = ArtefactHit | MaterialHit;

export interface ScanResult {
  mode: ScanMode;
  hits: ScanHit[];
  // Temporary rebuilt-grid diagnostic. One entry per physical slot, carrying the
  // slot's place on the fitted lattice so the preview can be laid out the way the
  // interface is. Packing tiles in sequence meant one wrong slot shifted every
  // tile after it and the rows stopped lining up with the game.
  debugSlots: DebugSlot[];
  debugColumns: number;
  debugRows: number;
  // "screen" = one pass's lattice. "stitched" = scroll session rebuilt into
  // storage order by aligning overlapping items across passes.
  debugLayout: "screen" | "stitched";
  spritesChecked: number;
  durationMs: number;
  workbenchDetected: boolean;
  advancedMatching: boolean;
  // Closest icons that were still rejected, for working out why. `cell` ties an
  // entry to its slot, so teaching that slot can clear its diagnostic too.
  // Percentages, as judged by the matcher: how much of the sprite agreed, and how
  // much of the slot it accounted for.
  nearMisses: { cell: number; name: string; precision: number; recall: number }[];
  // Occupied slots the matcher could not name, cropped from the screen so the
  // user can label them. A labelled crop becomes a learned sprite.
  unresolved: UnresolvedSlot[];
  // Rectangle covering the storage grid, reused by live scroll passes.
  searchArea: ScanArea | null;
  interfaceKind: ScanInterface;
  // Phase 1/2 stitch preview — full storage still built while scrolling.
  stitchPreviewUrl?: string;
  /** Top-left of the stitch crop in game-screen pixels (for mouse→cell teach). */
  stitchScreenOrigin?: { x: number; y: number };
  /** Live crop height in screen pixels (one viewport strip). */
  stitchViewportHeight?: number;
  /** Composite height before trailing empty trim (for last-viewport mapping). */
  stitchHeightBeforeTrim?: number;
  /** Slot centres in stitch-image pixels. */
  latticeCentres?: {
    columns: number[];
    rows: number[];
    cellWidth: number;
    cellHeight: number;
  };
}

export interface DebugSlot {
  row: number;
  column: number;
  // Item identity, so a scroll session can collect what it saw across passes
  // without counting the same item twice as it moves up the screen.
  key: string;
  name: string;
  quantity: number;
  // Path under public/, never a learned key — those are not image files and were
  // showing as broken icons even when the slot itself matched correctly.
  iconPath: string;
  // "hit" = named. "miss" = occupied slot the matcher could not name (red warning).
  kind: "hit" | "miss";
  // Screen crop for a miss, so the debug grid shows what was actually there
  // instead of a blank that looks like an empty slot.
  cropDataUrl?: string;
}

export interface UnresolvedSlot {
  cell: number;
  dataUrl: string;
  quantity: number;
  // Coarse fingerprint of the slot, so "not an artefact" can be remembered.
  signature: string;
  // The closest guess, pre-selected in the teach dropdown.
  guessKey: string | null;
  guessName: string | null;
}

type Target =
  | { type: "artefact"; artefact: Artefact; kind: "damaged" | "restored"; file: string }
  | { type: "material"; material: MaterialInfo; file: string };

type LoadedTarget = Target & {
  image: ImageData;
  deepImage: ImageData;
  // Indexed pixels and detail measure used by the precision/recall matcher, which
  // is what decides whether a slot holds this item. See src/matcher.ts.
  fit: MatchSprite | null;
};

export interface ScanArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DetectedInterface {
  kind: ScanInterface;
  // The matched title text, for the debug overlay.
  title: ScanArea;
  area: ScanArea;
}

export interface ScanOptions {
  debugOverlay?: boolean;
  advancedMatching?: boolean;
  fast?: boolean;
  searchArea?: ScanArea;
  interfaceKind?: ScanInterface;
  debugOverlayWidth?: number;
  debugOverlayMs?: number;
  expect?: ScanInterface;
  scrolling?: boolean;
  /** Pre-captured / stitched pixels — skips live capture + title detect. */
  pixels?: ImageData;
}

/**
 * Cheap fingerprint of a screen region, for telling whether the interface is
 * still moving.
 */
export const paneSignature = (area: ScanArea): number | null => {
  let pixels: ImageData | null = null;
  try {
    pixels = a1lib.capture(area.x, area.y, area.width, area.height);
  } catch {
    return null;
  }
  if (!pixels) return null;
  let hash = 2166136261;
  for (let index = 0; index < pixels.data.length; index += 4 * 17) {
    hash = Math.imul(hash ^ pixels.data[index], 16777619);
  }
  return hash >>> 0;
};

// RS3 draws stack counts in yellow under 100k, white under 10m, then green.
const STACK_COLOURS: [number, number, number][] = [
  [255, 255, 0],
  [255, 255, 255],
  [0, 255, 128],
];

// Popup titles are drawn in a serif small-caps face that Alt1 has no font for,
// so OCR never reads them. Every glyph core is instead a single flat colour, so
// the title is recognised as a pixel pattern lifted from reference captures.
const TITLE_GLYPH: [number, number, number] = [240, 190, 121];
// Anti-aliased glyph edges blend into the bar behind them, which is textured
// and stretches with the window, so only core pixels are trusted.
const TITLE_GLYPH_TOLERANCE = 12;
// Titles are stamped, not rendered per-window, but a stray overlay or the
// mouse cursor can cover a glyph or two.
const TITLE_MIN_HIT_RATIO = 0.9;
// The looser retries below can light up the chrome as well as the glyphs, so a
// match is rejected when far more of its rectangle is lit than the text needs.
const TITLE_MAX_LIT_RATIO = 2;
// How far the pattern is nudged around a candidate band before giving up.
const TITLE_ALIGN_RADIUS = 3;

const TITLE_FILES: { kind: ScanInterface; file: string }[] = [
  { kind: "workbench", file: "title-workbench.png" },
  { kind: "bank", file: "title-bank.png" },
  { kind: "material-storage", file: "title-material-storage.png" },
];

export const INTERFACE_NAMES: Record<ScanInterface, string> = {
  bank: "Bank of Gielinor",
  workbench: "Archaeologist’s Workbench",
  "material-storage": "Material Storage",
};

// The stack count is printed over the top rows of a slot, so those rows of a
// wiki icon can never match the screen. Alt1 skips fully transparent pixels,
// so clearing their alpha turns the digits into a don't-care region. Icons that
// fill the full slot height reach furthest into the text, hence two depths: the
// second is only tried for icons the first pass failed to find.
const STACK_TEXT_ROWS = 13;
const STACK_TEXT_ROWS_DEEP = 18;
// A deeply masked icon has less left to match on, so demand a close fit.
const DEEP_MAX_SCORE = 30;
// A slot is 36x32, so hits this close together are the same slot.
const SLOT_RADIUS = 16;
// Crops are canvas work plus a data URL each, so the teach list cannot be allowed
// to grow without bound on a busy storage grid.
const MAX_UNRESOLVED_CROPS = 60;
// The bank mixes ~1,200 untracked items in with the artefacts, so reporting every
// unmatched slot buries the teach list in soil, logs and coins. A redrawn artefact
// still has our sprite's silhouette — same model, new shading — so a slot the
// closest sprite largely accounts for is worth reporting even though its colours
// failed. Untracked junk has no such fit.
const BANK_REPORT_MIN_OUTLINE = 0.65;
// The teach dropdown only pre-selects when the guess very nearly claimed the slot.
// Below this the name is noise, and a wrong pre-selection is worse than none.
const GUESS_MIN_OUTLINE = 0.55;
const GUESS_MIN_PRECISION = 0.6;
// Worth listing as a near miss at all.
const REPORT_MIN_PRECISION = 0.5;
// Drawn pixels a slot needs before it is treated as holding anything. An empty
// slot measures a handful from its border shading; the smallest damaged artefact
// in a reference bank capture drew well over a hundred.
const SLOT_MIN_INK = 40;
const GRID_MIN_PITCH = 20;
// Keeps a softened match from displacing an exact one.
const BLUR_SCORE_PENALTY = 100;

const targetName = (target: LoadedTarget): string =>
  target.type === "artefact"
    ? `${target.artefact.name} (${target.kind})`
    : target.material.name;

// Preview artwork for the rebuilt grid. Always the framed wiki file for that item,
// even when the slot was claimed by a learned crop — learned keys are not files.
const framedIconPath = (target: LoadedTarget): string => {
  if (target.type === "artefact") {
    const entry = sprites.artefacts[target.artefact.id];
    const file = entry?.[target.kind] ?? entry?.restored;
    return file ? `sprites-framed/${file}` : "ui/archaeology.png";
  }
  const file = sprites.materials[target.material.id];
  return file ? `sprites-framed/${file}` : "ui/materials.png";
};

const cache = new Map<ScanMode, LoadedTarget[]>();
const pending = new Map<ScanMode, Promise<LoadedTarget[]>>();

const targetsFor = (mode: ScanMode): Target[] => {
  const targets: Target[] = [];

  if (mode === "materials" || mode === "both") {
    for (const material of archaeologyData.materials) {
      if (!isArchaeologyMaterial(material)) continue;
      const file = sprites.materials[material.id];
      if (file) targets.push({ type: "material", material, file });
    }
    if (mode === "materials") return targets;
  }

  for (const artefact of archaeologyData.artefacts) {
    const entry = sprites.artefacts[artefact.id];
    if (entry?.damaged) {
      targets.push({ type: "artefact", artefact, kind: "damaged", file: entry.damaged });
    }
    if (entry?.restored) {
      targets.push({ type: "artefact", artefact, kind: "restored", file: entry.restored });
    }
  }
  return targets;
};

const maskStackText = (image: ImageData, depth: number): ImageData => {
  const masked = new ImageData(
    new Uint8ClampedArray(image.data), image.width, image.height,
  );
  // Always leave a usable amount of the icon behind on short sprites.
  const rows = Math.min(depth, Math.max(0, image.height - 12));
  for (let index = 3; index < rows * image.width * 4; index += 4) {
    masked.data[index] = 0;
  }
  return masked;
};

// Coarse 8x8 grayscale of a slot, skipping the stack-count rows so the same item
// fingerprints the same whatever its stack size. Used to remember the slots the
// user has marked as not being an artefact or material.
const cellSignature = (
  source: ImageData, left: number, top: number, width: number, height: number,
): string => {
  const grid = 8;
  const skip = Math.min(STACK_TEXT_ROWS, Math.max(0, height - 12));
  const usableTop = top + skip;
  const usableHeight = Math.max(1, height - skip);

  let signature = "";
  for (let cellY = 0; cellY < grid; cellY += 1) {
    for (let cellX = 0; cellX < grid; cellX += 1) {
      const startX = left + Math.floor((cellX * width) / grid);
      const endX = left + Math.floor(((cellX + 1) * width) / grid);
      const startY = usableTop + Math.floor((cellY * usableHeight) / grid);
      const endY = usableTop + Math.floor(((cellY + 1) * usableHeight) / grid);

      let sum = 0;
      let samples = 0;
      for (let y = startY; y < Math.max(endY, startY + 1); y += 1) {
        for (let x = startX; x < Math.max(endX, startX + 1); x += 1) {
          if (x < 0 || y < 0 || x >= source.width || y >= source.height) continue;
          const index = (y * source.width + x) * 4;
          sum += (source.data[index] + source.data[index + 1] + source.data[index + 2]) / 3;
          samples += 1;
        }
      }
      const mean = samples ? sum / samples : 0;
      signature += Math.min(15, Math.floor(mean / 16)).toString(16);
    }
  }
  return signature;
};

// Lifts a slot-sized rectangle out of the captured screen as an opaque PNG,
// for teaching and for previewing the icon the matcher could not name.
const cropToDataUrl = (
  source: ImageData, left: number, top: number, width: number, height: number,
): string => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  const out = context.createImageData(width, height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const di = (row * width + column) * 4;
      const sx = left + column;
      const sy = top + row;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const si = (sy * source.width + sx) * 4;
      out.data[di] = source.data[si];
      out.data[di + 1] = source.data[si + 1];
      out.data[di + 2] = source.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  context.putImageData(out, 0, 0);
  return canvas.toDataURL("image/png");
};

const bitmapToImageData = async (blob: Blob): Promise<ImageData | null> => {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
};

const decodeSprite = async (file: string): Promise<ImageData | null> => {
  try {
    // Scanner needles are the wiki pixels placed in the same 32x32 frame as the
    // cache/client icon. The original wiki sprites remain under /sprites for UI
    // display and as an untouched fallback.
    const response = await fetch(`${import.meta.env.BASE_URL}sprites-framed/${file}`);
    if (!response.ok) return null;
    return await bitmapToImageData(await response.blob());
  } catch {
    return null;
  }
};

const decodeDataUrl = async (dataUrl: string): Promise<ImageData | null> => {
  try {
    return await bitmapToImageData(await (await fetch(dataUrl)).blob());
  } catch {
    return null;
  }
};

const artefactById = new Map(
  archaeologyData.artefacts.map((artefact) => [artefact.id, artefact]),
);
const materialById = new Map(
  archaeologyData.materials.map((material) => [material.id, material]),
);

const learnedKeyOf = (target: Target): string =>
  target.type === "artefact"
    ? artefactLearnedKey(target.artefact.id, target.kind)
    : materialLearnedKey(target.material.id);

// Turns a stored learned key back into a scan target for the given mode.
const learnedTarget = (key: string, mode: ScanMode): Target | null => {
  const parsed = parseLearnedKey(key);
  if (!parsed) return null;
  if (parsed.type === "artefact" && (mode === "artefacts" || mode === "both")) {
    const artefact = artefactById.get(parsed.id);
    if (!artefact) return null;
    return { type: "artefact", artefact, kind: parsed.kind, file: key };
  }
  if (parsed.type === "material" && (mode === "materials" || mode === "both")) {
    const material = materialById.get(parsed.id);
    if (!material) return null;
    return { type: "material", material, file: key };
  }
  return null;
};

const finaliseTarget = (target: Target, source: ImageData): LoadedTarget => {
  return {
    ...target,
    // Alt1's own pixel search has no notion of a slot, so the needles it gets keep
    // the stack rows cleared to make those pixels don't-care.
    image: maskStackText(source, STACK_TEXT_ROWS),
    deepImage: maskStackText(source, STACK_TEXT_ROWS_DEEP),
    // The matcher does know where the slot is, so it indexes the whole sprite and
    // excludes stack pixels by slot position instead. See src/matcher.ts.
    fit: prepareSprite(source),
  };
};

export const clearTargetCache = (): void => {
  cache.clear();
  pending.clear();
};

const loadTargets = (mode: ScanMode): Promise<LoadedTarget[]> => {
  const cached = cache.get(mode);
  if (cached) return Promise.resolve(cached);

  const inflight = pending.get(mode);
  if (inflight) return inflight;

  const job = (async () => {
    const targets = targetsFor(mode);
    const loaded: LoadedTarget[] = [];

    for (let index = 0; index < targets.length; index += 24) {
      const batch = await Promise.all(
        targets.slice(index, index + 24).map(async (target) => ({
          target,
          image: await decodeSprite(target.file),
        })),
      );
      for (const item of batch) {
        if (!item.image) continue;
        loaded.push(finaliseTarget(item.target, item.image));
      }
    }

    // Learned crops come from the live client, so they are appended last and
    // win exact ties — they should match their slot near-perfectly next time.
    const learned = loadLearned();
    for (const [key, dataUrl] of Object.entries(learned)) {
      const target = learnedTarget(key, mode);
      if (!target) continue;
      const image = await decodeDataUrl(dataUrl);
      if (image) loaded.push(finaliseTarget(target, image));
    }

    cache.set(mode, loaded);
    pending.delete(mode);
    return loaded;
  })();

  pending.set(mode, job);
  return job;
};

// Average per-pixel colour distance, ignoring pixels the sprite masks out.
const matchScore = (
  screen: ImageData, needle: ImageData, x: number, y: number,
): number => {
  if (x < 0 || y < 0) return Infinity;
  if (x + needle.width > screen.width || y + needle.height > screen.height) return Infinity;

  let total = 0;
  let weight = 0;
  for (let row = 0; row < needle.height; row += 1) {
    let needleIndex = row * needle.width * 4;
    let screenIndex = ((y + row) * screen.width + x) * 4;
    for (let column = 0; column < needle.width; column += 1) {
      const alpha = needle.data[needleIndex + 3] / 255;
      if (alpha) {
        const diff =
          Math.abs(screen.data[screenIndex] - needle.data[needleIndex]) +
          Math.abs(screen.data[screenIndex + 1] - needle.data[needleIndex + 1]) +
          Math.abs(screen.data[screenIndex + 2] - needle.data[needleIndex + 2]);
        total += diff * alpha;
        weight += alpha;
      }
      needleIndex += 4;
      screenIndex += 4;
    }
  }
  return weight ? total / weight : Infinity;
};

const isStackInk = (r: number, g: number, b: number): boolean =>
  (r >= 200 && g >= 200 && b <= 90) ||
  (r >= 220 && g >= 220 && b >= 220) ||
  (r <= 50 && g >= 190 && b >= 80 && b <= 180);

/**
 * Read the stack count in the top-left of a slot. Alt1's OCR needs a seed point
 * *inside* the glyphs — feeding the cell corner misses most digits. Locate
 * yellow/white ink first, then OCR from its centre.
 */
const readStackQuantity = (screen: ImageData, cellLeft: number, cellTop: number): number => {
  const zoneW = 24;
  const zoneH = 14;
  let sumX = 0;
  let sumY = 0;
  let ink = 0;
  for (let y = cellTop; y < cellTop + zoneH && y < screen.height; y += 1) {
    for (let x = cellLeft; x < cellLeft + zoneW && x < screen.width; x += 1) {
      if (x < 0 || y < 0) continue;
      const index = (y * screen.width + x) * 4;
      if (!isStackInk(screen.data[index], screen.data[index + 1], screen.data[index + 2])) {
        continue;
      }
      sumX += x;
      sumY += y;
      ink += 1;
    }
  }
  // A lone digit is ~10–25 yellow pixels; empty slots have none.
  // Bank placeholders draw a yellow "0" — that is not "quantity 1".
  if (ink < 6) return 1;

  const cx = Math.round(sumX / ink);
  const cy = Math.round(sumY / ink);
  // findReadLine must seed *inside* the glyph. Yellow ink mass sits near the
  // top of the digit; the readable match is lower (font baseline). Sweep a
  // few points down from the ink centroid.
  const seeds: [number, number][] = [];
  for (const dy of [0, 2, 3, 4, 5]) {
    for (const dx of [0, -2, 2, -4]) {
      seeds.push([cx + dx, cy + dy]);
    }
  }
  seeds.push([cellLeft + 8, cellTop + 6], [cellLeft + 10, cellTop + 8]);

  let best = 1;
  let sawZero = false;
  for (const [ox, oy] of seeds) {
    try {
      // Narrow horizontal band — same pattern Alt1 uses for mono digit lines.
      const line = OCR.findReadLine(screen, digitFont, STACK_COLOURS, ox, oy, 22, 1);
      const digits = line?.text?.replace(/[^0-9]/g, "") ?? "";
      if (!digits) continue;
      const value = Number(digits);
      if (!Number.isFinite(value) || value < 0) continue;
      if (value === 0) {
        sawZero = true;
        continue;
      }
      if (value > best) best = value;
      if (value > 1) return value;
    } catch {
      // try next seed
    }
  }
  // Placeholder slot in the bank: yellow "0" and no larger stack reading.
  if (sawZero && best === 1) return 0;
  return best;
};

interface TitleSignature {
  kind: ScanInterface;
  width: number;
  height: number;
  // Core pixel offsets from the pattern's top-left, packed as x,y pairs.
  points: Int16Array;
}

const isGlyphPixel = (
  data: Uint8ClampedArray,
  index: number,
  tolerance = TITLE_GLYPH_TOLERANCE,
): boolean =>
  Math.abs(data[index] - TITLE_GLYPH[0]) +
    Math.abs(data[index + 1] - TITLE_GLYPH[1]) +
    Math.abs(data[index + 2] - TITLE_GLYPH[2]) <=
  tolerance;

const signatureFrom = (
  kind: ScanInterface,
  image: ImageData,
): TitleSignature | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!isGlyphPixel(image.data, (y * image.width + x) * 4)) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 40) return null;

  let minX = xs[0];
  let maxX = xs[0];
  let minY = ys[0];
  let maxY = ys[0];
  for (let n = 1; n < xs.length; n += 1) {
    if (xs[n] < minX) minX = xs[n];
    if (xs[n] > maxX) maxX = xs[n];
    if (ys[n] < minY) minY = ys[n];
    if (ys[n] > maxY) maxY = ys[n];
  }

  const points = new Int16Array(xs.length * 2);
  for (let n = 0; n < xs.length; n += 1) {
    points[n * 2] = xs[n] - minX;
    points[n * 2 + 1] = ys[n] - minY;
  }
  return { kind, width: maxX - minX + 1, height: maxY - minY + 1, points };
};

let titleSignatures: Promise<TitleSignature[]> | null = null;

const loadTitleSignatures = (): Promise<TitleSignature[]> => {
  titleSignatures ??= (async () => {
    const loaded = await Promise.all(
      TITLE_FILES.map(async ({ kind, file }) => {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}ui/${file}`);
          if (!response.ok) return null;
          const image = await bitmapToImageData(await response.blob());
          return image ? signatureFrom(kind, image) : null;
        } catch {
          return null;
        }
      }),
    );
    return loaded.filter((entry): entry is TitleSignature => Boolean(entry));
  })();
  return titleSignatures;
};

// Gold padlock drawn in material-storage slots that have not been unlocked yet.
// Cropped from a live slot (Arch reference/Locked_Slot.PNG); dark floor is
// transparent so prepareSprite only compares lock ink.
let padlockSprite: Promise<MatchSprite | null> | null = null;

const loadPadlockSprite = (): Promise<MatchSprite | null> => {
  padlockSprite ??= (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}ui/slot-padlock.png`);
      if (!response.ok) return null;
      const image = await bitmapToImageData(await response.blob());
      return image ? prepareSprite(image) : null;
    } catch {
      return null;
    }
  })();
  return padlockSprite;
};

// Tetracompass pieces sit in the bank but are not artefacts/materials — blank
// those cells so soft matching does not invent a nearby shield name.
const TETRA_BLANK_FILES = [
  "tetracompass-piece-left.png",
  "tetracompass-piece-right.png",
  "tetracompass-piece-dial.png",
  "tetracompass-piece-needle.png",
];

let tetraBlankSprites: Promise<MatchSprite[]> | null = null;

const loadTetraBlankSprites = (): Promise<MatchSprite[]> => {
  tetraBlankSprites ??= (async () => {
    const loaded = await Promise.all(
      TETRA_BLANK_FILES.map(async (file) => {
        try {
          const image = await decodeSprite(file);
          return image ? prepareSprite(image) : null;
        } catch {
          return null;
        }
      }),
    );
    return loaded.filter((sprite): sprite is MatchSprite => Boolean(sprite));
  })();
  return tetraBlankSprites;
};

// Windows resize, so the box is deliberately generous: it only has to contain
// the storage grid, which the first pass then measures precisely. The bank is
// much wider relative to its short title than the other two.
const TITLE_AREA_WIDTH: Record<ScanInterface, number> = {
  bank: 1120,
  workbench: 700,
  "material-storage": 620,
};
const TITLE_AREA_HEIGHT = 820;

const areaFromTitle = (
  image: ImageData,
  title: ScanArea,
  kind: ScanInterface,
): ScanArea => {
  const centre = title.x + title.width / 2;
  const halfWidth = TITLE_AREA_WIDTH[kind] / 2;
  const left = Math.max(0, Math.round(centre - halfWidth));
  const right = Math.min(image.width, Math.round(centre + halfWidth));
  // Start below the title glyphs — including the title bar used to pull soft
  // matching into chrome. The storage grid sits under the caption.
  const top = Math.max(0, title.y + title.height + 4);
  const bottom = Math.min(image.height, top + TITLE_AREA_HEIGHT);
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const findTitle = (
  image: ImageData,
  signatures: TitleSignature[],
  tolerance: number,
): DetectedInterface | null => {
  // One sweep collects every glyph-coloured pixel. On a reference capture the
  // whole screen held 274 of them, 257 of which were the title, so the bands
  // below are usually the title on its own.
  const glyph = new Uint8Array(image.width * image.height);
  const rows: { y: number; minX: number; maxX: number; count: number }[] = [];
  for (let y = 0; y < image.height; y += 1) {
    let minX = image.width;
    let maxX = -1;
    let count = 0;
    const rowStart = y * image.width;
    for (let x = 0; x < image.width; x += 1) {
      if (!isGlyphPixel(image.data, (rowStart + x) * 4, tolerance)) continue;
      glyph[rowStart + x] = 1;
      if (x < minX) minX = x;
      maxX = x;
      count += 1;
    }
    if (count >= 2) rows.push({ y, minX, maxX, count });
  }

  const bands: { minX: number; maxX: number; minY: number; maxY: number; count: number }[] = [];
  for (const row of rows) {
    const band = bands.at(-1);
    if (band && row.y - band.maxY <= 3) {
      band.maxY = row.y;
      band.minX = Math.min(band.minX, row.minX);
      band.maxX = Math.max(band.maxX, row.maxX);
      band.count += row.count;
    } else {
      bands.push({
        minX: row.minX, maxX: row.maxX, minY: row.y, maxY: row.y, count: row.count,
      });
    }
  }

  const matches = (signature: TitleSignature, originX: number, originY: number): boolean => {
    if (originX < 0 || originY < 0) return false;
    if (originX + signature.width > image.width) return false;
    if (originY + signature.height > image.height) return false;
    const { points } = signature;
    const total = points.length / 2;
    const allowedMisses = Math.floor(total * (1 - TITLE_MIN_HIT_RATIO));
    let missed = 0;
    for (let n = 0; n < points.length; n += 2) {
      if (glyph[(originY + points[n + 1]) * image.width + originX + points[n]]) continue;
      if (++missed > allowedMisses) return false;
    }

    // A loose tolerance can light up the brown chrome as well as the glyphs,
    // and a solid block of lit pixels matches any pattern laid over it. Real
    // text leaves the space between its letters dark.
    let lit = 0;
    for (let row = 0; row < signature.height; row += 1) {
      const rowStart = (originY + row) * image.width + originX;
      for (let column = 0; column < signature.width; column += 1) {
        if (glyph[rowStart + column]) lit += 1;
      }
    }
    return lit <= total * TITLE_MAX_LIT_RATIO;
  };

  for (const band of bands) {
    const bandWidth = band.maxX - band.minX + 1;
    for (const signature of signatures) {
      if (band.count < (signature.points.length / 2) * TITLE_MIN_HIT_RATIO) continue;
      if (bandWidth + TITLE_ALIGN_RADIUS < signature.width) continue;

      // A clean band starts exactly where the pattern does. Sweeping only
      // matters when something else lit up on the title's rows, which is what
      // the looser tolerance passes tend to drag in.
      const lastX = Math.max(
        band.minX + TITLE_ALIGN_RADIUS,
        band.maxX - signature.width + 1,
      );
      const lastY = Math.max(
        band.minY + TITLE_ALIGN_RADIUS,
        band.maxY - signature.height + 1,
      );

      for (let y = band.minY - TITLE_ALIGN_RADIUS; y <= lastY; y += 1) {
        for (let x = band.minX - TITLE_ALIGN_RADIUS; x <= lastX; x += 1) {
          if (!matches(signature, x, y)) continue;
          const title = { x, y, width: signature.width, height: signature.height };
          return {
            kind: signature.kind,
            title,
            area: areaFromTitle(image, title, signature.kind),
          };
        }
      }
    }
  }
  return null;
};

const detectInterface = async (
  image: ImageData,
): Promise<DetectedInterface | null> => {
  const signatures = await loadTitleSignatures();
  if (!signatures.length) return null;
  // The exact glyph colour is what the client draws, but brightness and
  // colour-blindness settings shift it, so failures retry more loosely.
  for (const tolerance of [TITLE_GLYPH_TOLERANCE, 45, 90]) {
    const found = findTitle(image, signatures, tolerance);
    if (found) return found;
  }
  return null;
};

/**
 * Locate the storage window on screen (title → search rectangle). Used by the
 * scroll stitch loop before any matching.
 */
export const locateStorage = async (
  expect?: ScanInterface,
): Promise<DetectedInterface> => {
  if (!window.alt1?.permissionPixel) {
    throw new Error("Alt1 needs the “View screen” permission before scanning.");
  }
  const screen = a1lib.captureHoldFullRs();
  if (!screen) throw new Error("Alt1 could not capture the RuneScape window.");
  const pixels = screen.toData();
  const detected = await detectInterface(pixels);
  if (!detected) {
    throw new Error(
      `Could not find ${expect ? INTERFACE_NAMES[expect] : "Bank of Gielinor, Archaeologist’s Workbench, or Material Storage"}. Keep its title bar visible.`,
    );
  }
  if (expect && detected.kind !== expect) {
    throw new Error(
      `Found ${INTERFACE_NAMES[detected.kind]} on screen, not ${INTERFACE_NAMES[expect]}.`,
    );
  }
  return detected;
};

const clusterCentres = (values: number[], joinWithin = 12): number[] => {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const value of sorted) {
    const group = groups.at(-1);
    if (group && value - group.at(-1)! <= joinWithin) group.push(value);
    else groups.push([value]);
  }
  return groups.map(
    (group) => group.reduce((sum, value) => sum + value, 0) / group.length,
  );
};

/**
 * Crop rectangle for scroll-stitching: only the left storage slot grid (the
 * same kind of tight 5-column strip as a manual screenshot of the pane). Found
 * by probing a few item sprites so we do not include world / backpack / buttons.
 */
export const locateStitchCrop = async (
  expect?: ScanInterface,
): Promise<{ detected: DetectedInterface; crop: ScanArea }> => {
  if (!window.alt1?.permissionPixel) {
    throw new Error("Alt1 needs the “View screen” permission before scanning.");
  }
  const screen = a1lib.captureHoldFullRs();
  if (!screen) throw new Error("Alt1 could not capture the RuneScape window.");
  const pixels = screen.toData();
  const detected = await detectInterface(pixels);
  if (!detected) {
    throw new Error(
      `Could not find ${expect ? INTERFACE_NAMES[expect] : "Bank of Gielinor, Archaeologist’s Workbench, or Material Storage"}. Keep its title bar visible.`,
    );
  }
  if (expect && detected.kind !== expect) {
    throw new Error(
      `Found ${INTERFACE_NAMES[detected.kind]} on screen, not ${INTERFACE_NAMES[expect]}.`,
    );
  }

  const mode: ScanMode =
    detected.kind === "material-storage"
      ? "materials"
      : detected.kind === "bank"
        ? "both"
        : "artefacts";
  const allTargets = await loadTargets(mode);
  const targets =
    detected.kind === "workbench"
      ? allTargets.filter(
          (target) => target.type === "artefact" && target.kind === "damaged",
        )
      : allTargets;

  // Bank is a wide open grid — need more seeds so pitch and the inventory cut
  // are measured across the full pane, not a tight cluster of a few icons.
  const seedBudget = detected.kind === "bank" ? 48 : 24;
  const centres: { x: number; y: number }[] = [];
  for (const target of targets) {
    if (centres.length >= seedBudget) break;
    let positions: { x: number; y: number }[] = [];
    try {
      positions = screen.findSubimage(
        target.image,
        detected.area.x,
        detected.area.y,
        detected.area.width,
        detected.area.height,
      );
    } catch {
      continue;
    }
    for (const position of positions) {
      const x = position.x + target.image.width / 2;
      const y = position.y + target.image.height / 2;
      const slot = readSlot(pixels, x, y, 44);
      if (slot.count < SLOT_MIN_INK) continue;
      // Prefer spread: skip a hit that sits on a centre we already have.
      if (
        centres.some(
          (c) => Math.abs(c.x - x) < 10 && Math.abs(c.y - y) < 10,
        )
      ) {
        continue;
      }
      centres.push({ x, y });
      if (centres.length >= seedBudget) break;
    }
  }

  if (centres.length < 3) {
    throw new Error(
      "Could not see the storage grid to stitch. Scroll so some items are on screen and try again.",
    );
  }

  let columns = clusterCentres(centres.map((c) => c.x));
  let rows = clusterCentres(centres.map((c) => c.y));

  // Drop the backpack / equipment pane: first wide gap between columns.
  let paneRight = Infinity;
  if (
    (detected.kind === "workbench" || detected.kind === "bank") &&
    columns.length >= 2
  ) {
    const gaps = columns.slice(1).map((c, i) => c - columns[i]);
    const pitch = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const cut = gaps.findIndex((gap) => gap > pitch * 1.55);
    if (cut >= 0) {
      paneRight = columns[cut] + pitch * 0.5;
      columns = columns.slice(0, cut + 1);
      const kept = centres.filter((c) => c.x <= paneRight);
      rows = clusterCentres(kept.map((c) => c.y));
    }
  }

  if (!columns.length || !rows.length) {
    throw new Error(
      "Could not measure the storage grid to stitch. Keep the left storage list visible.",
    );
  }

  let pitchX =
    columns.length >= 2
      ? (columns.at(-1)! - columns[0]) / (columns.length - 1)
      : 42;
  let pitchY =
    rows.length >= 2 ? (rows.at(-1)! - rows[0]) / (rows.length - 1) : pitchX;

  // Workbench left storage is a fixed 5-column pane (offline crop ≈ 212×398).
  // Do NOT expand rows to the full interface height — that pulls Withdraw /
  // Deposit / scrollbar into the stitch (what broke the live preview). Bank
  // may expand into its window; workbench must not copy that.
  if (detected.kind === "workbench") {
    const colGaps =
      columns.length >= 2
        ? columns.slice(1).map((c, i) => c - columns[i])
        : [];
    pitchX = Math.max(
      36,
      Math.min(
        48,
        colGaps.length
          ? [...colGaps].sort((a, b) => a - b)[Math.floor(colGaps.length / 2)]
          : 42,
      ),
    );
    pitchY = Math.max(
      32,
      Math.min(44, rows.length >= 2 ? pitchY : pitchX * 0.85),
    );

    const originX = columns[0];
    const originY = rows[0];
    columns = Array.from(
      { length: 5 },
      (_, index) => originX + index * pitchX,
    );

    // Bottom of the slot list only — stop above the yellow action strip.
    // Offline still is ~11 rows (398px); never expand into Withdraw/Deposit.
    const chromeTop = probeWorkbenchChromeTop(
      pixels,
      originX - pitchX * 0.5,
      originX + pitchX * 5,
      originY,
      detected.area.y + detected.area.height,
    );
    const bottomLimit = Math.min(
      chromeTop - pitchY * 0.4,
      // Offline left pane is 11 slot rows — do not invent a 12th into chrome.
      originY + pitchY * 10.5,
    );
    const candidateRows: number[] = [];
    for (let y = originY; y <= bottomLimit - pitchY * 0.35; y += pitchY) {
      candidateRows.push(y);
    }
    if (candidateRows.length >= 1) rows = candidateRows;

    // Hard right edge: five columns only (ignore a weak backpack pane cut).
    paneRight = originX + pitchX * 5;
  }

  // Bank windows resize (column/row count changes). Measure this window's left
  // grid from seeds + the inventory gap, expand columns/rows to that pane.
  // Blank floor under the last items is trimmed from the finished stitch.
  if (detected.kind === "bank") {
    const originX = columns[0];
    const originY = rows[0];

    // Inventory cut from seeds, or probe for the first wide low-ink gap after
    // the leftmost bank columns (works when the backpack had no seed hits).
    if (!Number.isFinite(paneRight)) {
      paneRight = probeBankPaneRight(
        pixels,
        detected.area,
        originX,
        pitchX,
      );
    }

    const rightLimit = Number.isFinite(paneRight)
      ? paneRight
      : Math.min(pixels.width, originX + pitchX * 14);
    // Search / filter strip sits under the slot grid.
    const bottomLimit =
      detected.area.y + detected.area.height - Math.max(48, pitchY * 1.15);

    const expandedCols: number[] = [];
    for (let x = originX; x <= rightLimit - pitchX * 0.35; x += pitchX) {
      expandedCols.push(x);
    }
    if (expandedCols.length >= 2) columns = expandedCols;

    // Visible slot rows for this window size (resize-safe). Include empty slots
    // in the live crop so scrolling still feeds new items into the same rect;
    // trailing blank floor is trimmed from the finished stitch before matching.
    const candidateRows: number[] = [];
    for (let y = originY; y <= bottomLimit - pitchY * 0.35; y += pitchY) {
      candidateRows.push(y);
    }
    if (candidateRows.length >= 1) rows = candidateRows;
  }

  const padX = pitchX * 0.5;
  const padY = pitchY * 0.5;
  const left = Math.max(0, Math.round(columns[0] - padX));
  const top = Math.max(0, Math.round(rows[0] - padY));
  const right = Math.min(
    pixels.width,
    Math.round(
      Number.isFinite(paneRight) &&
        (detected.kind === "bank" || detected.kind === "workbench")
        ? Math.min(columns.at(-1)! + padX, paneRight)
        : columns.at(-1)! + padX,
    ),
  );
  const bottom = Math.min(pixels.height, Math.round(rows.at(-1)! + padY));

  const crop: ScanArea = {
    x: left,
    y: top,
    width: Math.max(40, right - left),
    height: Math.max(40, bottom - top),
  };
  return { detected, crop };
};

/**
 * Top of the workbench Withdraw / Deposit strip (yellow action chrome under the
 * left storage list). Offline crops stop above this; live stitch must too.
 */
function probeWorkbenchChromeTop(
  pixels: ImageData,
  left: number,
  right: number,
  fromY: number,
  toY: number,
): number {
  const x0 = Math.max(0, Math.round(left));
  const x1 = Math.min(pixels.width, Math.round(right));
  const y0 = Math.max(0, Math.round(fromY));
  const y1 = Math.min(pixels.height, Math.round(toY));
  if (x1 - x0 < 20 || y1 - y0 < 20) return y1;

  for (let y = y0; y < y1; y += 1) {
    let yellow = 0;
    let samples = 0;
    for (let x = x0; x < x1; x += 2) {
      const index = (y * pixels.width + x) * 4;
      const r = pixels.data[index];
      const g = pixels.data[index + 1];
      const b = pixels.data[index + 2];
      samples += 1;
      if (r >= 170 && g >= 130 && b <= 110 && r >= b + 60 && g >= b + 40) {
        yellow += 1;
      }
    }
    // A continuous yellow band across the pane = action buttons, not stack digits.
    if (samples >= 20 && yellow >= Math.max(12, samples * 0.08)) {
      return y;
    }
  }
  return y1;
}

/**
 * Find the right edge of the bank item grid (before backpack / equipment).
 * Walks right from the first slot column looking for a stretch wider than a
 * normal slot pitch with little icon ink — the gap before inventory.
 */
function probeBankPaneRight(
  pixels: ImageData,
  area: ScanArea,
  originX: number,
  pitchX: number,
): number {
  const top = Math.max(area.y, Math.round(originX > 0 ? area.y + 40 : area.y));
  const bottom = Math.min(area.y + area.height - 60, pixels.height);
  const stripH = Math.max(20, bottom - top);
  if (stripH < 20) return area.x + area.width * 0.65;

  const inkInStrip = (x0: number, x1: number): number => {
    let ink = 0;
    const left = Math.max(0, Math.round(x0));
    const right = Math.min(pixels.width, Math.round(x1));
    for (let y = top; y < bottom; y += 3) {
      for (let x = left; x < right; x += 2) {
        const i = (y * pixels.width + x) * 4;
        const lum = pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2];
        if (lum > 140) ink += 1;
      }
    }
    return ink;
  };

  // Sample per half-pitch from a few columns in; bank stays busy, the gap dips.
  const start = originX + pitchX * 2.5;
  const end = Math.min(pixels.width - 8, area.x + area.width - 8);
  let bestGap = -1;
  let bestScore = Infinity;
  for (let x = start; x < end - pitchX; x += pitchX * 0.5) {
    const gapInk = inkInStrip(x, x + pitchX * 1.2);
    const leftInk = inkInStrip(x - pitchX, x);
    const rightInk = inkInStrip(x + pitchX * 1.2, x + pitchX * 2.2);
    // A real pane split: quiet gap between two busier regions (bank | inventory).
    if (leftInk > 30 && rightInk > 20 && gapInk < leftInk * 0.45 && gapInk < bestScore) {
      bestScore = gapInk;
      bestGap = x + pitchX * 0.6;
    }
  }
  if (bestGap > 0) return bestGap;

  // Fallback: stop after ~12 columns (common max-ish bank width at 100% UI).
  return Math.min(end, originX + pitchX * 12.5);
};

/**
 * Drop trailing empty bank floor from a stitched still. Uses bright-pixel rows
 * (icons / stack text) rather than raw ink count — wood grain was keeping a
 * full empty strip under the last item row.
 */
export const trimTrailingEmptySlotRows = (
  image: ImageData,
  pitchY = 36,
): ImageData => {
  let lastContentBottom = 0;
  const stepX = 3;
  for (let y = 0; y < image.height; y += 1) {
    let bright = 0;
    let samples = 0;
    const row = y * image.width * 4;
    for (let x = 0; x < image.width; x += stepX) {
      const i = row + x * 4;
      const lum = image.data[i] + image.data[i + 1] + image.data[i + 2];
      samples += 1;
      // Icons and yellow stack digits; dark bank wood stays below this.
      if (lum > 150) bright += 1;
    }
    if (bright >= 10 && bright / samples >= 0.015) {
      lastContentBottom = y;
    }
  }
  if (lastContentBottom < 16) return image;
  // Tight pad under the last icon pixels — bank matching no longer needs a
  // half-slot margin for visibility gates.
  const pad = Math.max(4, Math.round(pitchY * 0.12));
  const height = Math.min(image.height, lastContentBottom + pad + 1);
  if (height >= image.height - 2) return image;
  const data = new Uint8ClampedArray(image.width * height * 4);
  data.set(image.data.subarray(0, image.width * height * 4));
  return new ImageData(data, image.width, height);
};

/**
 * Match sprites against an already-captured image (live screen or a stitched
 * storage still). When `options.pixels` is set, that buffer is used instead of
 * capturing; pass `interfaceKind` for composites that have no title bar.
 */
export const scanImageData = async (
  pixels: ImageData,
  mode: ScanMode,
  onProgress?: (checked: number, total: number) => void,
  options: ScanOptions = {},
): Promise<ScanResult> =>
  scanScreen(mode, onProgress, { ...options, pixels });

export const scanScreen = async (
  mode: ScanMode,
  onProgress?: (checked: number, total: number) => void,
  {
    debugOverlay = false,
    advancedMatching = false,
    fast = false,
    searchArea,
    interfaceKind,
    expect,
    scrolling = false,
    debugOverlayWidth = 1,
    debugOverlayMs = 6000,
    pixels: providedPixels,
  }: ScanOptions = {},
): Promise<ScanResult> => {
  if (!window.alt1?.permissionPixel && !providedPixels) {
    throw new Error("Alt1 needs the “View screen” permission before scanning.");
  }

  const started = performance.now();
  let screen: a1lib.ImgRef;
  let pixels: ImageData;
  let detected: DetectedInterface | null;

  if (providedPixels) {
    if (!interfaceKind) {
      throw new Error("scanImageData needs interfaceKind for a stitched image.");
    }
    pixels = providedPixels;
    screen = new a1lib.ImgRefData(providedPixels);
    const area = { x: 0, y: 0, width: pixels.width, height: pixels.height };
    detected = { kind: interfaceKind, title: area, area };
  } else {
    const captured = a1lib.captureHoldFullRs();
    if (!captured) throw new Error("Alt1 could not capture the RuneScape window.");
    screen = captured;
    pixels = screen.toData();
    detected =
      searchArea && interfaceKind
        ? { kind: interfaceKind, title: searchArea, area: searchArea }
        : await detectInterface(pixels);
  }

  if (!detected) {
    throw new Error(
      `Could not find ${expect ? INTERFACE_NAMES[expect] : "Bank of Gielinor, Archaeologist’s Workbench, or Material Storage"}. Keep its title bar visible.`,
    );
  }
  if (expect && detected.kind !== expect) {
    throw new Error(
      `Found ${INTERFACE_NAMES[detected.kind]} on screen, not ${INTERFACE_NAMES[expect]}.`,
    );
  }
  if (mode === "materials" && detected.kind !== "material-storage") {
    throw new Error("Open Material Storage before scanning materials.");
  }
  if (mode === "both" && detected.kind !== "bank") {
    throw new Error("Open the Bank of Gielinor before scanning it.");
  }
  if (
    mode === "artefacts" &&
    detected.kind !== "bank" &&
    detected.kind !== "workbench"
  ) {
    throw new Error("Open the Bank of Gielinor or Archaeologist’s Workbench before scanning artefacts.");
  }

  const allTargets = await loadTargets(mode);
  const targets = detected.kind === "workbench"
    ? allTargets.filter(
        (target) => target.type === "artefact" && target.kind === "damaged",
      )
    : allTargets;
  const padlock =
    detected.kind === "material-storage" ? await loadPadlockSprite() : null;
  // `exact` records whether the pixels agreed outright rather than being accepted
  // as a redrawn icon. A row clipped by the scroll viewport can only ever produce
  // the looser kind, so this is what lets edge rows be judged more strictly.
  const slots: {
    x: number;
    y: number;
    score: number;
    exact: boolean;
    precision: number;
    target: LoadedTarget;
  }[] = [];
  const nearMisses: ScanResult["nearMisses"] = [];
  // Right-hand limit of the workbench storage grid. The title only says roughly
  // where the window is, so the edge comes from the grid itself once found.
  let storageEdge = Infinity;
  const unresolvedCells: { x: number; y: number; guess: LoadedTarget | null }[] = [];
  let area: ScanArea | undefined = detected.area;
  // Cells are ~44px in the reference capture, but interface scale varies, so the
  // window follows the measured grid where one is known.
  let slotSize = 44;
  let latticeX: { origin: number; pitch: number } | null = null;
  let latticeY: { origin: number; pitch: number } | null = null;

  // Full cell size comes from the fitted grid pitch once known, otherwise the
  // default slot window. A cell is scannable only when that whole rectangle sits
  // inside the visible storage region (the interface / search area).
  const cellWidthPx = (): number => latticeX?.pitch ?? slotSize;
  const cellHeightPx = (): number => latticeY?.pitch ?? slotSize;

  const isFullCellVisible = (centreX: number, centreY: number): boolean => {
    const cellW = cellWidthPx();
    const cellH = cellHeightPx();
    const left = centreX - cellW / 2;
    const top = centreY - cellH / 2;
    const right = left + cellW;
    const bottom = top + cellH;
    const view = area;
    if (!view) return true;
    const tol = 2;
    return (
      left >= view.x - tol &&
      top >= view.y - tol &&
      right <= view.x + view.width + tol &&
      bottom <= view.y + view.height + tol
    );
  };

  const claimSlot = (
    target: LoadedTarget,
    position: { x: number; y: number },
    score: number,
    exact = true,
    precision = 1,
  ): boolean => {
    if (position.x + target.image.width / 2 > storageEdge) return false;
    const centreX = position.x + target.image.width / 2;
    const centreY = position.y + target.image.height / 2;
    // Only name a slot when the full cell rectangle is on screen.
    if (!isFullCellVisible(centreX, centreY)) return false;
    // Similar icons can both match a slot, so the closest one wins.
    const slot = slots.find(
      (other) =>
        Math.abs(other.x - position.x) < SLOT_RADIUS &&
        Math.abs(other.y - position.y) < SLOT_RADIUS,
    );
    if (!slot) {
      slots.push({ x: position.x, y: position.y, score, exact, precision, target });
      return true;
    }
    if (score < slot.score) {
      slot.score = score;
      slot.exact = exact;
      slot.precision = precision;
      slot.target = target;
      return true;
    }
    return false;
  };

  const search = (target: LoadedTarget, needle: ImageData, area?: ScanArea): number => {
    let positions: { x: number; y: number }[] = [];
    try {
      positions = area
        ? screen.findSubimage(needle, area.x, area.y, area.width, area.height)
        : screen.findSubimage(needle);
    } catch {
      positions = [];
    }
    // Storage never holds one item type in two slots, so a sprite keeps only its
    // best position. Without that a low-detail icon spreads itself across the
    // grid and every copy is counted as another find.
    let best: { position: { x: number; y: number }; score: number } | null = null;
    for (const position of positions) {
      const score = matchScore(pixels, needle, position.x, position.y);
      if (needle === target.deepImage && score > DEEP_MAX_SCORE) continue;
      if (!best || score < best.score) best = { position, score };
    }
    if (!best) return 0;
    // A pixel search can only say "these colours appear here", which a small dull
    // sprite satisfies on plenty of slots it has nothing to do with. Confirm the
    // hit explains the slot's contents before counting it, on the same terms the
    // softened pass uses.
    if (!confirmFit(target, best.position)) return 0;
    return claimSlot(target, best.position, best.score) ? 1 : 0;
  };

  const isWorkbench = detected.kind === "workbench";
  // The workbench holds only damaged artefacts and material storage only
  // materials, so whatever is in a slot there is something we have a sprite for.
  // The bank mixes in ~1,200 untracked items, so it gets no such benefit.
  // Declared before confirmFit / search: those close over it, and the search
  // loop runs before the rest of the scan.
  const closedSet = detected.kind !== "bank";

  const confirmFit = (target: LoadedTarget, position: { x: number; y: number }): boolean => {
    if (!target.fit) return false;
    const centreX = position.x + target.image.width / 2;
    const centreY = position.y + target.image.height / 2;
    const slot = readSlot(pixels, centreX, centreY, slotSize);
    return (
      judgeFit(measureFit(pixels, target.fit, slot, centreX, centreY), target.fit, closedSet) !==
      null
    );
  };

  const missed: LoadedTarget[] = [];
  const yieldEvery = fast ? 80 : 25;

  // Each storage kind has its own stitch matcher (offline-parity). Do not share
  // soft-locate paths across bank / workbench / material-storage.
  const materialStitchOffline =
    Boolean(providedPixels) && detected.kind === "material-storage";
  const bankStitchOffline =
    Boolean(providedPixels) && detected.kind === "bank";
  const workbenchStitchOffline =
    Boolean(providedPixels) && detected.kind === "workbench";
  const latticeStitchOffline =
    materialStitchOffline || bankStitchOffline || workbenchStitchOffline;

  if (!latticeStitchOffline) {
    for (const [index, target] of targets.entries()) {
      if (!search(target, target.image, area)) missed.push(target);

      if (index % yieldEvery === 0) {
        onProgress?.(index, targets.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  } else {
    for (const target of targets) missed.push(target);
  }

  function slotsArea(pad: number): ScanArea | undefined {
    if (slots.length < 2) return undefined;
    const left = Math.max(0, Math.min(...slots.map((slot) => slot.x)) - pad);
    const top = Math.max(0, Math.min(...slots.map((slot) => slot.y)) - pad);
    const right = Math.min(
      pixels.width,
      Number.isFinite(storageEdge) ? storageEdge : pixels.width,
      Math.max(...slots.map((slot) => slot.x + slot.target.image.width)) + pad,
    );
    const bottom = Math.min(
      pixels.height,
      Math.max(...slots.map((slot) => slot.y + slot.target.image.height)) + pad,
    );
    const width = right - left;
    const height = bottom - top;
    if (width < 40 || height < 40) return undefined;
    return { x: left, y: top, width, height };
  }

  // The bank and the workbench both put their storage grid on the left and the
  // player's backpack on the right, so both need the backpack cutting away.
  if (isWorkbench || detected.kind === "bank") keepStoragePaneOnly();

  // Storage on the left, the player's inventory on the right, with a gap between
  // the two grids that is wider than the regular column pitch. Only the storage
  // pane holds what we are counting, so anything past that gap is dropped before
  // the retries widen the search. Confining the retries also speeds them up.
  function keepStoragePaneOnly(): void {
    if (slots.length < 3) return;

    const columns = clusterLine(
      slots.map((slot) => slot.x + slot.target.image.width / 2),
    );
    if (columns.length < 2) return;

    const gaps = columns
      .slice(1)
      .map((centre, index) => centre - columns[index])
      .filter((gap) => gap >= GRID_MIN_PITCH);
    if (!gaps.length) return;

    const pitch = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    let edge = Infinity;
    for (let index = 1; index < columns.length; index += 1) {
      if (columns[index] - columns[index - 1] > pitch * 1.6) {
        edge = columns[index] - pitch / 2;
        break;
      }
    }
    if (!Number.isFinite(edge)) return;

    storageEdge = edge;
    for (let index = slots.length - 1; index >= 0; index -= 1) {
      const slot = slots[index];
      if (slot.x + slot.target.image.width / 2 > edge) slots.splice(index, 1);
    }
  }

  // Exact matches locate the storage interface. Every more expensive retry is
  // restricted to this rectangle instead of walking the entire 1440p frame.
  const retryArea = slotsArea(80) ?? area;

  // The deep stack-mask retry, restricted to the grid rectangle. Live passes run
  // it too: it is the pass that rescues icons whose stack text overlaps further
  // than the standard mask, and skipping it cost items during scroll scans.
  // Material-storage / bank stitches skip this — they use the offline soft-locate path.
  const retryTargets = latticeStitchOffline
    ? []
    : isWorkbench
      ? missed.filter(
          (target) => target.type === "artefact" && target.kind === "damaged",
        )
      : missed;
  const stillMissed = retryTargets.filter(
    (target) => !search(target, target.deepImage, retryArea),
  );

  // Slot centres repeat on a fixed pitch. Fill gaps between the outermost
  // confirmed icons only — never invent a row/column outside the storage grid
  // (that used to paint red boxes on the title bar, scrollbar and buttons).
  function clusterLine(values: number[]): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (const value of sorted) {
      const group = groups.at(-1);
      if (group && value - group.at(-1)! <= 10) group.push(value);
      else groups.push([value]);
    }
    return groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
  }

  function expandLine(centres: number[]): number[] {
    if (centres.length < 2) return centres;
    let pitch = Infinity;
    for (let index = 1; index < centres.length; index += 1) {
      const gap = centres[index] - centres[index - 1];
      if (gap >= GRID_MIN_PITCH && gap < pitch) pitch = gap;
    }
    if (!Number.isFinite(pitch)) return centres;

    const line: number[] = [];
    const last = centres.at(-1)!;
    for (let value = centres[0]; value <= last + 1; value += pitch) line.push(value);
    return line;
  }

  // Wiki sprites are trimmed to the item, so no two are the same size and the
  // artwork sits off-centre in the cell. Fit one regular lattice from every hit:
  // the widest pitch that still fits every centre closely wins, and the phase is
  // the median offset so one oddly-trimmed sprite cannot pull the whole line.
  function fitLattice(values: number[]): { origin: number; pitch: number } | null {
    const centres = clusterLine(values);
    if (centres.length < 2) return null;

    const offsetFrom = (value: number, origin: number, pitch: number): number => {
      const remainder = (((value - origin) % pitch) + pitch) % pitch;
      return remainder > pitch / 2 ? remainder - pitch : remainder;
    };

    const fitPitch = (pitch: number): { origin: number; pitch: number; residual: number } => {
      const base = centres[0];
      const offsets = centres
        .map((centre) => offsetFrom(centre, base, pitch))
        .sort((a, b) => a - b);
      const origin = base + offsets[Math.floor(offsets.length / 2)];
      const residual =
        centres.reduce((sum, centre) => sum + Math.abs(offsetFrom(centre, origin, pitch)), 0) /
        centres.length;
      return { origin, pitch, residual };
    };

    const gaps = [
      ...new Set(centres.slice(1).map((centre, index) => Math.round(centre - centres[index]))),
    ].filter((gap) => gap >= GRID_MIN_PITCH);
    if (!gaps.length) return null;

    const fits = gaps.map(fitPitch).sort((a, b) => b.pitch - a.pitch);
    return fits.find((fit) => fit.residual <= 3) ?? fits.reduce(
      (best, fit) => (fit.residual < best.residual ? fit : best),
    );
  }

  function snapToLattice(
    value: number,
    lattice: { origin: number; pitch: number } | null,
  ): number {
    if (!lattice) return value;
    const steps = Math.round((value - lattice.origin) / lattice.pitch);
    const snapped = lattice.origin + steps * lattice.pitch;
    return Math.abs(snapped - value) <= lattice.pitch / 2 ? snapped : value;
  }

  // Walk the fitted lattice from the outermost confirmed hits. Optional bounds
  // can extend past those hits, but soft matching must not use a large search
  // rectangle — that walked into Withdraw/Deposit and invented phantom slots.
  function expandFromLattice(
    lattice: { origin: number; pitch: number } | null,
    centres: number[],
    boundMin?: number,
    boundMax?: number,
  ): number[] {
    if (!lattice) return expandLine(centres);
    if (centres.length < 1) return [];
    let first = Math.round((Math.min(...centres) - lattice.origin) / lattice.pitch);
    let last = Math.round((Math.max(...centres) - lattice.origin) / lattice.pitch);
    if (boundMin !== undefined) {
      first = Math.min(first, Math.round((boundMin - lattice.origin) / lattice.pitch));
    }
    if (boundMax !== undefined) {
      last = Math.max(last, Math.round((boundMax - lattice.origin) / lattice.pitch));
    }
    const line: number[] = [];
    for (let step = first; step <= last; step += 1) {
      line.push(lattice.origin + step * lattice.pitch);
    }
    return line;
  }

  // Soft pass, overlays and teach crops all share this lattice so red cells land
  // on the same centres the green boxes use.
  if (!latticeStitchOffline) {
    latticeX = fitLattice(slots.map((slot) => slot.x + slot.target.image.width / 2));
    latticeY = fitLattice(slots.map((slot) => slot.y + slot.target.image.height / 2));
  }

  // Once the grid is known the slot window can follow it, which keeps the recall
  // measure correct at interface scales other than the 44px default.
  if (latticeX && latticeY) {
    // Icons are 32×32 inside a larger cell. Reading the full pitch pulls brown
    // padding into the ink mask and skews mean colour toward the background, which
    // made a green smoke-cloud scroll lose to a grey carving on the same slot.
    slotSize = Math.max(
      32,
      Math.min(36, Math.round(Math.min(latticeX.pitch, latticeY.pitch) - 8)),
    );
  }

  // Occupied cells we refuse to name (clip zone / incomplete cell) still need a
  // debug miss with a crop — otherwise a dropped icon looks like an empty slot.
  const deferredMissCentres: { x: number; y: number }[] = [];

  // Confirmed icons reveal the slot grid, and every slot on it is then classified
  // against the sprites still going spare. See src/matcher.ts for why a fit is
  // judged on precision, recall and sprite detail together rather than on colour
  // agreement alone.
  const gridPass = (allowSoft: boolean): void => {
    const remaining = stillMissed.filter((target) => target.fit);
    if (slots.length < 2 || !remaining.length) return;

    const hitX = slots.map((slot) => slot.x + slot.target.image.width / 2);
    const hitY = slots.map((slot) => slot.y + slot.target.image.height / 2);
    // Soft-match only on the lattice spanned by confirmed hits. Extending by a
    // pitch (or by the search rectangle) walked into Withdraw/Deposit and the
    // window frame — those have "ink", so they became phantom finds and teach
    // crops. A redrawn-only edge row is handled across scroll passes instead.
    // (Stitched closed-set scans use the audit-style path above instead.)
    const columns = expandFromLattice(latticeX, hitX);
    const rows = expandFromLattice(latticeY, hitY);
    if (!columns.length || !rows.length) return;

    type Candidate = { target: LoadedTarget; fit: Fit; verdict: "exact" | "redrawn" };
    type Cell = {
      x: number;
      y: number;
      content: "faint" | "filled";
      slot: SlotContent;
      candidates: Candidate[];
      // Closest sprite regardless of verdict, kept for the teach list.
      nearest: { target: LoadedTarget; fit: Fit } | null;
    };

    const cells: Cell[] = [];
    for (const centreY of rows) {
      const edgeRow =
        scrolling && rows.length > 1 && (centreY === rows[0] || centreY === rows.at(-1));
      for (const centreX of columns) {
        const filled = slots.some(
          (slot) =>
            Math.abs(slot.x + slot.target.image.width / 2 - centreX) < SLOT_RADIUS &&
            Math.abs(slot.y + slot.target.image.height / 2 - centreY) < SLOT_RADIUS,
        );
        if (filled) continue;
        if (isBlankCell(centreX, centreY)) continue;

        const contentProbe = cellContent(centreX, centreY);
        const slot = readSlot(pixels, centreX, centreY, slotSize);
        const occupied =
          !(contentProbe === "empty" && slot.count < SLOT_MIN_INK) &&
          !(slot.count < Math.max(20, SLOT_MIN_INK / 2) && contentProbe === "empty");

        // Clip-zone / incomplete cells: never claim, but if occupied leave a
        // debug miss so the hole is a red ! not a blank.
        if (edgeRow || !isFullCellVisible(centreX, centreY)) {
          if (occupied) deferredMissCentres.push({ x: centreX, y: centreY });
          continue;
        }
        if (!occupied) continue;

        const content = contentProbe === "filled" ? "filled" : "faint";
        const candidates: Candidate[] = [];
        let nearest: { target: LoadedTarget; fit: Fit } | null = null;
        for (const target of remaining) {
          if (!roughlyFits(pixels, target.fit!, slot, centreX, centreY)) continue;
          const fit = measureFit(pixels, target.fit!, slot, centreX, centreY);
          if (!nearest || fitStrength(fit) > fitStrength(nearest.fit)) {
            nearest = { target, fit };
          }
          const verdict = judgeFit(fit, target.fit!, closedSet);
          if (verdict) candidates.push({ target, fit, verdict });
        }
        candidates.sort(
          (a, b) =>
            rankOf(b.verdict, b.fit, b.target.fit!, slot) -
            rankOf(a.verdict, a.fit, a.target.fit!, slot),
        );
        cells.push({ x: centreX, y: centreY, content, slot, candidates, nearest });
      }
    }

    // Storage never holds one item type twice, so each sprite goes to the slot it
    // fits best and each slot names one item. Assigning as the grid was walked
    // handed a sprite to the first cell that happened to like it, so a stack of
    // soil in the top row could take an artefact that belonged further down —
    // inventing one hit and hiding the real one.
    const ranked: { cell: Cell; pick: Candidate }[] = [];
    for (const cell of cells) {
      for (const pick of cell.candidates) ranked.push({ cell, pick });
    }
    // Certainty first: an exact match must not lose its slot to a looser reading of
    // a different item that happens to cover more of it. See rankOf.
    ranked.sort(
      (a, b) =>
        rankOf(b.pick.verdict, b.pick.fit, b.pick.target.fit!, b.cell.slot) -
        rankOf(a.pick.verdict, a.pick.fit, a.pick.target.fit!, a.cell.slot),
    );

    const takenTargets = new Set<LoadedTarget>();
    const claimedCells = new Set<Cell>();
    for (const { cell, pick } of ranked) {
      if (!allowSoft && pick.verdict !== "exact") continue;
      // Multi-pass scroll used to merge weak soft names into phantoms. A single
      // stitched/static still does not — closed-set soft that clears judgeFit is
      // trusted. Bank / live scrolling still need the high soft gate.
      if (scrolling && pick.verdict !== "exact") continue;
      if (
        pick.verdict === "redrawn" &&
        !(closedSet && !scrolling) &&
        (pick.fit.precision < TRUSTED_SOFT_PRECISION || pick.fit.recall < 0.72)
      ) {
        continue;
      }
      // A faint cell is too close to an empty slot to name from a redrawn icon
      // in the bank, where junk is common. Closed containers (workbench /
      // material storage) have no junk, and damaged artefacts are often dark
      // enough that cellContent calls them faint — ceremonial plume was matching
      // at 86%/89% and then being skipped here, which is how scroll scans stuck
      // at 52 of 53.
      if (
        cell.content === "faint" &&
        pick.verdict !== "exact" &&
        !closedSet
      ) continue;
      if (claimedCells.has(cell) || takenTargets.has(pick.target)) continue;
      takenTargets.add(pick.target);
      claimedCells.add(cell);
      claimSlot(
        pick.target,
        pick.fit,
        BLUR_SCORE_PENALTY,
        pick.verdict === "exact",
        pick.fit.precision,
      );
    }

    // Live passes skip the report work entirely — the final thorough pass covers
    // teaching.
    if (fast) return;

    // The workbench and material storage hold only trackable items, so there every
    // unmatched slot counts. The bank also holds ~1,200 untracked items, so a slot
    // only earns a place in the teach list when some sprite very nearly fits it.
    const bankFiltered = detected.kind === "bank";

    for (const cell of cells) {
      if (claimedCells.has(cell)) continue;
      const nearest = cell.nearest;
      if (bankFiltered && (nearest?.fit.recall ?? 0) < BANK_REPORT_MIN_OUTLINE) continue;

      // Only pre-select when the guess very nearly claimed the slot. Weak fits
      // (Ivory sickle on every brown cell) stay on "Pick the item…".
      const confident =
        nearest &&
        nearest.fit.recall >= GUESS_MIN_OUTLINE &&
        nearest.fit.precision >= GUESS_MIN_PRECISION;
      const index = unresolvedCells.length;
      unresolvedCells.push({ x: cell.x, y: cell.y, guess: confident ? nearest.target : null });

      if (nearest && nearest.fit.precision >= REPORT_MIN_PRECISION) {
        nearMisses.push({
          cell: index,
          name: targetName(nearest.target),
          precision: Math.round(nearest.fit.precision * 100),
          recall: Math.round(nearest.fit.recall * 100),
        });
      }
    }
  };

  // Empty bank slots are flat and dark; occupied ones have brighter icon pixels.
  // Measured across a workbench capture, empty slots vary by under 500 while
  // occupied ones reach 4000-7000. Two cuts, so a faint icon that falls short of
  // "occupied" is still reported as unmatched rather than dropped in silence.
  const cellContent = (centreX: number, centreY: number): "empty" | "faint" | "filled" => {
    const left = Math.round(centreX - 14);
    const top = Math.round(centreY - 14);
    let bright = 0;
    let samples = 0;
    let sum = 0;
    let sumSq = 0;
    for (let y = top; y < top + 28; y += 2) {
      for (let x = left; x < left + 28; x += 2) {
        if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
        const index = (y * pixels.width + x) * 4;
        const lum = pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2];
        sum += lum;
        sumSq += lum * lum;
        samples += 1;
        if (lum > 140) bright += 1;
      }
    }
    if (samples < 20) return "empty";
    const mean = sum / samples;
    const variance = sumSq / samples - mean * mean;
    if (bright >= 6 || variance > 900) return "filled";
    return bright >= 2 || variance > 400 ? "faint" : "empty";
  };

  // Withdraw / Deposit labels are bright yellow glyphs on the wood panel. Soft
  // matching used to treat that ink as occupied inventory and invent a row of
  // false finds / teach crops under the real grid.
  //
  // Material storage (and stacked bank items) also draw yellow stack digits in
  // the top-left of every slot — those must NOT count as chrome, or almost every
  // material cell is skipped and the debug grid shows "empty".
  const looksLikeUiChrome = (centreX: number, centreY: number): boolean => {
    const left = Math.round(centreX - 14);
    const top = Math.round(centreY - 14);
    let yellow = 0;
    let samples = 0;
    // Stack counts live in roughly the top-left 14×12 of the slot; ignore that
    // corner so Withdraw/Deposit (yellow across the middle of the cell) still trip.
    const stackX1 = left + 14;
    const stackY1 = top + 12;
    for (let y = top; y < top + 28; y += 2) {
      for (let x = left; x < left + 28; x += 2) {
        if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
        if (x < stackX1 && y < stackY1) continue;
        const index = (y * pixels.width + x) * 4;
        const r = pixels.data[index];
        const g = pixels.data[index + 1];
        const b = pixels.data[index + 2];
        samples += 1;
        if (r >= 170 && g >= 130 && b <= 110 && r >= b + 60 && g >= b + 40) {
          yellow += 1;
        }
      }
    }
    return samples >= 16 && yellow >= 6;
  };

  // Material storage draws a gold padlock in slots that have not been unlocked
  // yet (public/ui/slot-padlock.png from a live crop). Those are not materials —
  // treat them as empty blanks rather than unmatched red !.
  // Bank tetra pieces are recorded into stitchBlankCells by the stitch matcher.
  const stitchBlankCells = new Set<string>();
  const looksLikeLockedSlot = (centreX: number, centreY: number): boolean => {
    if (!padlock || detected.kind !== "material-storage") return false;
    const slot = readSlot(pixels, centreX, centreY, Math.max(slotSize, 36));
    const fit = measureFit(pixels, padlock, slot, centreX, centreY);
    return fit.precision >= 0.75;
  };

  const isBlankCell = (centreX: number, centreY: number): boolean =>
    stitchBlankCells.has(`${centreX.toFixed(1)},${centreY.toFixed(1)}`) ||
    looksLikeUiChrome(centreX, centreY) ||
    looksLikeLockedSlot(centreX, centreY);

  // Stitched stills use the same assignment as scripts/diag/audit.mjs: every
  // occupied cell is scored against every sprite, then claimed competitively.
  // findSubimage-first + soft-on-remainder is what left single holes the offline
  // audit never saw (sprite stolen by an earlier weak hit, or never in remaining).
  //
  // When a stitch expands its lattice, keep it for the debug grid too —
  // rebuilding later from hit centres alone drops blank rows (e.g. padlocks).
  // (Stitched bank / workbench / materials return before this soft assembler.)
  let stitchGridColumns: number[] | null = null;
  let stitchGridRows: number[] | null = null;

  /** Wiki framed sprites only — learned crops must not compete on stitch parity. */
  const wikiStitchTargets = () =>
    targets
      .filter((target) => target.fit && target.file.endsWith(".png"))
      .map((target) => ({ fit: target.fit!, image: target.image, ref: target }));

  if (materialStitchOffline) {
    // Material Storage: offline matcher only (rebuild-materials-canvas.mjs port).
    const matTargets = wikiStitchTargets();
    const matched = await matchMaterialStorageStitch(
      pixels,
      matTargets,
      padlock,
      onProgress,
    );
    const cellWidth = Math.round(
      Math.min(Math.max(matched.latticeX.pitch || 36, 36), 48),
    );
    const cellHeight = Math.round(
      Math.min(Math.max(matched.latticeY.pitch || 32, 32), 44),
    );
    const keyOf = (target: LoadedTarget): string =>
      target.type === "artefact"
        ? `${target.artefact.id}:${target.kind}`
        : `mat:${target.material.id}`;

    const merged = new Map<string, ScanHit>();
    const debugHits: DebugSlot[] = [];
    for (const claim of matched.claims) {
      const target = claim.target.ref as LoadedTarget;
      const left = Math.round(claim.centreX - cellWidth / 2);
      const top = Math.round(claim.centreY - cellHeight / 2);
      const quantity = readStackQuantity(pixels, left, top);

      debugHits.push({
        row: claim.row,
        column: claim.column,
        key: keyOf(target),
        name: targetName(target),
        quantity,
        iconPath: framedIconPath(target),
        kind: "hit",
        cropDataUrl: cropToDataUrl(pixels, left, top, cellWidth, cellHeight),
      });

      const key = keyOf(target);
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.exact ||= claim.exact;
      } else if (target.type === "artefact") {
        merged.set(key, {
          type: "artefact",
          artefact: target.artefact,
          kind: target.kind,
          quantity,
          exact: claim.exact,
          edgeRow: false,
        });
      } else {
        merged.set(key, {
          type: "material",
          material: target.material,
          quantity,
          exact: claim.exact,
          edgeRow: false,
        });
      }
    }

    const debugMisses: DebugSlot[] = [];
    const unresolved: UnresolvedSlot[] = [];
    const matNearMisses: ScanResult["nearMisses"] = [];

    for (const [index, entry] of matched.unresolved.entries()) {
      const left = Math.round(entry.x - cellWidth / 2);
      const top = Math.round(entry.y - cellHeight / 2);
      const guess = entry.guess ? (entry.guess.ref as LoadedTarget) : null;
      const quantity = readStackQuantity(pixels, left, top);
      const cropDataUrl = cropToDataUrl(pixels, left, top, cellWidth, cellHeight);
      const signature = cellSignature(pixels, left, top, cellWidth, cellHeight);

      debugMisses.push({
        row: entry.row,
        column: entry.column,
        key: `miss:${signature}`,
        name: guess ? targetName(guess) : "Not recognised",
        quantity,
        iconPath: guess ? framedIconPath(guess) : "",
        kind: "miss",
        cropDataUrl,
      });

      if (entry.precision >= REPORT_MIN_PRECISION && guess) {
        matNearMisses.push({
          cell: index,
          name: targetName(guess),
          precision: Math.round(entry.precision * 100),
          recall: Math.round(entry.recall * 100),
        });
      }

      if (!fast && unresolved.length < MAX_UNRESOLVED_CROPS) {
        unresolved.push({
          cell: index,
          dataUrl: cropDataUrl,
          quantity,
          signature,
          guessKey: guess ? learnedKeyOf(guess) : null,
          guessName: guess ? targetName(guess) : null,
        });
      }
    }

    const hits = [...merged.values()].sort((a, b) => {
      const nameA = a.type === "artefact" ? a.artefact.name : a.material.name;
      const nameB = b.type === "artefact" ? b.artefact.name : b.material.name;
      return nameA.localeCompare(nameB);
    });

    onProgress?.(targets.length, targets.length);

    return {
      mode,
      hits,
      debugSlots: [...debugHits, ...debugMisses],
      debugColumns: Math.max(1, matched.columns.length),
      debugRows: Math.max(1, matched.rows.length),
      debugLayout: "stitched",
      spritesChecked: matTargets.length,
      durationMs: Math.round(performance.now() - started),
      workbenchDetected: false,
      advancedMatching: true,
      nearMisses: matNearMisses
        .sort((a, b) => b.precision + b.recall - (a.precision + a.recall))
        .slice(0, 10),
      unresolved,
      searchArea: {
        x: 0,
        y: 0,
        width: pixels.width,
        height: pixels.height,
      },
      interfaceKind: "material-storage",
      latticeCentres: {
        columns: [...matched.columns],
        rows: [...matched.rows],
        cellWidth,
        cellHeight,
      },
    };
  }

  if (workbenchStitchOffline) {
    // Workbench: offline matcher only (rebuild-stitch-canvas.mjs port).
    const wbTargets = wikiStitchTargets();
    const matched = await matchWorkbenchStorageStitch(
      pixels,
      wbTargets,
      onProgress,
    );
    const cellWidth = Math.round(
      Math.min(Math.max(matched.latticeX.pitch || 36, 36), 48),
    );
    const cellHeight = Math.round(
      Math.min(Math.max(matched.latticeY.pitch || 32, 32), 44),
    );
    const keyOf = (target: LoadedTarget): string =>
      target.type === "artefact"
        ? `${target.artefact.id}:${target.kind}`
        : `mat:${target.material.id}`;

    const merged = new Map<string, ScanHit>();
    const debugHits: DebugSlot[] = [];
    for (const claim of matched.claims) {
      const target = claim.target.ref as LoadedTarget;
      const left = Math.round(claim.centreX - cellWidth / 2);
      const top = Math.round(claim.centreY - cellHeight / 2);
      const quantity = Math.max(1, readStackQuantity(pixels, left, top));

      debugHits.push({
        row: claim.row,
        column: claim.column,
        key: keyOf(target),
        name: targetName(target),
        quantity,
        iconPath: framedIconPath(target),
        kind: "hit",
        cropDataUrl: cropToDataUrl(pixels, left, top, cellWidth, cellHeight),
      });

      const key = keyOf(target);
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.exact ||= claim.exact;
      } else if (target.type === "artefact") {
        merged.set(key, {
          type: "artefact",
          artefact: target.artefact,
          kind: target.kind,
          quantity,
          exact: claim.exact,
          edgeRow: false,
        });
      } else {
        merged.set(key, {
          type: "material",
          material: target.material,
          quantity,
          exact: claim.exact,
          edgeRow: false,
        });
      }
    }

    const debugMisses: DebugSlot[] = [];
    const unresolved: UnresolvedSlot[] = [];
    const wbNearMisses: ScanResult["nearMisses"] = [];

    for (const [index, entry] of matched.unresolved.entries()) {
      const left = Math.round(entry.x - cellWidth / 2);
      const top = Math.round(entry.y - cellHeight / 2);
      const guess = entry.guess ? (entry.guess.ref as LoadedTarget) : null;
      const quantity = Math.max(1, readStackQuantity(pixels, left, top));
      const cropDataUrl = cropToDataUrl(pixels, left, top, cellWidth, cellHeight);
      const signature = cellSignature(pixels, left, top, cellWidth, cellHeight);

      debugMisses.push({
        row: entry.row,
        column: entry.column,
        key: `miss:${signature}`,
        name: guess ? targetName(guess) : "Not recognised",
        quantity,
        iconPath: guess ? framedIconPath(guess) : "",
        kind: "miss",
        cropDataUrl,
      });

      if (entry.precision >= REPORT_MIN_PRECISION && guess) {
        wbNearMisses.push({
          cell: index,
          name: targetName(guess),
          precision: Math.round(entry.precision * 100),
          recall: Math.round(entry.recall * 100),
        });
      }

      if (!fast && unresolved.length < MAX_UNRESOLVED_CROPS) {
        unresolved.push({
          cell: index,
          dataUrl: cropDataUrl,
          quantity,
          signature,
          guessKey: guess ? learnedKeyOf(guess) : null,
          guessName: guess ? targetName(guess) : null,
        });
      }
    }

    const hits = [...merged.values()].sort((a, b) => {
      const nameA = a.type === "artefact" ? a.artefact.name : a.material.name;
      const nameB = b.type === "artefact" ? b.artefact.name : b.material.name;
      return nameA.localeCompare(nameB);
    });

    onProgress?.(targets.length, targets.length);

    return {
      mode,
      hits,
      debugSlots: [...debugHits, ...debugMisses],
      debugColumns: Math.max(1, matched.columns.length),
      debugRows: Math.max(1, matched.rows.length),
      debugLayout: "stitched",
      spritesChecked: wbTargets.length,
      durationMs: Math.round(performance.now() - started),
      workbenchDetected: true,
      advancedMatching: true,
      nearMisses: wbNearMisses
        .sort((a, b) => b.precision + b.recall - (a.precision + a.recall))
        .slice(0, 10),
      unresolved,
      searchArea: {
        x: 0,
        y: 0,
        width: pixels.width,
        height: pixels.height,
      },
      interfaceKind: "workbench",
      latticeCentres: {
        columns: [...matched.columns],
        rows: [...matched.rows],
        cellWidth,
        cellHeight,
      },
    };
  }

  if (bankStitchOffline) {
    const bankTargets = wikiStitchTargets();
    const blankSprites = await loadTetraBlankSprites();
    const matched = await matchBankStorageStitch(pixels, bankTargets, onProgress, {
      blankSprites,
    });

    // Offline parity: return matcher output as-is. Later chrome/lattice filters
    // were dropping soft archaeology claims the audit keeps (yellow ink, trim).
    const columns = matched.columns;
    const rows = matched.rows;
    const cellWidth = Math.round(
      Math.min(Math.max(matched.latticeX.pitch || 36, 36), 48),
    );
    const cellHeight = Math.round(
      Math.min(Math.max(matched.latticeY.pitch || 32, 32), 44),
    );
    const nearestIndex = (centres: number[], value: number): number => {
      let best = 0;
      for (let index = 1; index < centres.length; index += 1) {
        if (Math.abs(centres[index] - value) < Math.abs(centres[best] - value)) {
          best = index;
        }
      }
      return best;
    };
    const keyOf = (target: LoadedTarget): string =>
      target.type === "artefact"
        ? `${target.artefact.id}:${target.kind}`
        : `mat:${target.material.id}`;

    const blankCells = new Set(
      matched.blanks.map(
        (blank) =>
          `${nearestIndex(rows, blank.y)},${nearestIndex(columns, blank.x)}`,
      ),
    );

    const merged = new Map<string, ScanHit>();
    const debugHits: DebugSlot[] = [];
    for (const claim of matched.claims) {
      const target = claim.target.ref as LoadedTarget;
      const centreX = claim.centreX;
      const centreY = claim.centreY;
      const row = nearestIndex(rows, centreY);
      const column = nearestIndex(columns, centreX);
      const left = Math.round(centreX - cellWidth / 2);
      const top = Math.round(centreY - cellHeight / 2);
      const quantity = readStackQuantity(pixels, left, top);
      if (quantity === 0) continue;

      debugHits.push({
        row,
        column,
        key: keyOf(target),
        name: targetName(target),
        quantity,
        iconPath: framedIconPath(target),
        kind: "hit",
        cropDataUrl: cropToDataUrl(pixels, left, top, cellWidth, cellHeight),
      });

      const key = keyOf(target);
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.exact ||= claim.exact;
      } else if (target.type === "artefact") {
        merged.set(key, {
          type: "artefact",
          artefact: target.artefact,
          kind: target.kind,
          quantity,
          exact: claim.exact,
          edgeRow: false,
        });
      } else {
        merged.set(key, {
          type: "material",
          material: target.material,
          quantity,
          exact: claim.exact,
          edgeRow: false,
        });
      }
    }

    const taken = new Set(debugHits.map((slot) => `${slot.row},${slot.column}`));
    const debugMisses: DebugSlot[] = [];
    const unresolved: UnresolvedSlot[] = [];
    const bankNearMisses: ScanResult["nearMisses"] = [];

    for (const [index, entry] of matched.unresolved.entries()) {
      const row = nearestIndex(rows, entry.y);
      const column = nearestIndex(columns, entry.x);
      const cellKey = `${row},${column}`;
      if (blankCells.has(cellKey) || taken.has(cellKey)) continue;
      taken.add(cellKey);

      const left = Math.round(entry.x - cellWidth / 2);
      const top = Math.round(entry.y - cellHeight / 2);
      const guess = entry.guess ? (entry.guess.ref as LoadedTarget) : null;
      const quantity = readStackQuantity(pixels, left, top);
      const cropDataUrl = cropToDataUrl(pixels, left, top, cellWidth, cellHeight);
      const signature = cellSignature(pixels, left, top, cellWidth, cellHeight);

      debugMisses.push({
        row,
        column,
        key: `miss:${signature}`,
        name: guess ? targetName(guess) : "Not recognised",
        quantity,
        iconPath: guess ? framedIconPath(guess) : "",
        kind: "miss",
        cropDataUrl,
      });

      if (entry.precision >= REPORT_MIN_PRECISION && guess) {
        bankNearMisses.push({
          cell: index,
          name: targetName(guess),
          precision: Math.round(entry.precision * 100),
          recall: Math.round(entry.recall * 100),
        });
      }

      if (!fast && unresolved.length < MAX_UNRESOLVED_CROPS) {
        unresolved.push({
          cell: index,
          dataUrl: cropDataUrl,
          quantity,
          signature,
          guessKey: guess ? learnedKeyOf(guess) : null,
          guessName: guess ? targetName(guess) : null,
        });
      }
    }

    const hits = [...merged.values()].sort((a, b) => {
      const nameA = a.type === "artefact" ? a.artefact.name : a.material.name;
      const nameB = b.type === "artefact" ? b.artefact.name : b.material.name;
      return nameA.localeCompare(nameB);
    });

    onProgress?.(targets.length, targets.length);

    return {
      mode,
      hits,
      debugSlots: [...debugHits, ...debugMisses],
      debugColumns: Math.max(1, columns.length),
      debugRows: Math.max(1, rows.length),
      debugLayout: "stitched",
      spritesChecked: bankTargets.length,
      durationMs: Math.round(performance.now() - started),
      workbenchDetected: false,
      advancedMatching: true,
      nearMisses: bankNearMisses
        .sort((a, b) => b.precision + b.recall - (a.precision + a.recall))
        .slice(0, 10),
      unresolved,
      searchArea: {
        x: 0,
        y: 0,
        width: pixels.width,
        height: pixels.height,
      },
      interfaceKind: "bank",
      latticeCentres: {
        columns: [...columns],
        rows: [...rows],
        cellWidth,
        cellHeight,
      },
    };
  } else {
  // Live screen soft pass only. Stitched bank / workbench / materials each
  // return above from their own matcher — they never reach this assembler.
  gridPass(advancedMatching || (closedSet && !scrolling));
  }

  // Exact search may still have named clip-zone rows. Drop those claims from the
  // found list, but keep the centres as debug misses (crop + red !).
  if (scrolling && latticeY && slots.length >= 2) {
    const hitYs = slots.map((slot) => slot.y + slot.target.image.height / 2);
    const edgeRows = expandFromLattice(latticeY, hitYs);
    if (edgeRows.length >= 2) {
      const tol = latticeY.pitch * 0.35;
      for (let index = slots.length - 1; index >= 0; index -= 1) {
        const centreX = slots[index].x + slots[index].target.image.width / 2;
        const centreY = slots[index].y + slots[index].target.image.height / 2;
        if (
          Math.abs(centreY - edgeRows[0]) <= tol ||
          Math.abs(centreY - edgeRows.at(-1)!) <= tol
        ) {
          deferredMissCentres.push({ x: centreX, y: centreY });
          slots.splice(index, 1);
        }
      }
    }
  }

  // Soft claims must not stick on the Withdraw strip even if a lattice line
  // somehow lands there (wrong pitch, or an earlier outlier hit).
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index];
    if (slot.exact) continue;
    const centreX = slot.x + slot.target.image.width / 2;
    const centreY = slot.y + slot.target.image.height / 2;
    if (isBlankCell(centreX, centreY)) slots.splice(index, 1);
  }

  // claimSlot already keeps one hit per physical slot (anything within SLOT_RADIUS
  // merges). The only extra cleanup wanted here is dropping a match that sits
  // clearly between two slots — a real icon lands within a few px of a lattice
  // line, so a hit more than ~45% of the pitch away is not in a slot at all.
  // Merging by rounded cell was removed: when the fitted pitch is slightly off it
  // rounded two real neighbours to the same cell and discarded one.
  if (latticeX && latticeY && slots.length >= 6) {
    for (let index = slots.length - 1; index >= 0; index -= 1) {
      const slot = slots[index];
      const centreX = slot.x + slot.target.image.width / 2;
      const centreY = slot.y + slot.target.image.height / 2;
      const offX = Math.abs(snapToLattice(centreX, latticeX) - centreX);
      const offY = Math.abs(snapToLattice(centreY, latticeY) - centreY);
      if (offX > latticeX.pitch * 0.45 || offY > latticeY.pitch * 0.45) {
        slots.splice(index, 1);
      }
    }
  }

  // A clipped icon on a scroll-edge row is a bad teach crop, but the debug grid
  // still needs to show that slot as occupied-and-unmatched. Edge filtering
  // happens only when building teach crops below — not here.
  const cellWidth = Math.round(Math.min(Math.max(latticeX?.pitch ?? 36, 36), 48));
  const cellHeight = Math.round(Math.min(Math.max(latticeY?.pitch ?? 32, 32), 44));
  // Outlines sit inside the cell so neighbouring boxes keep a gap instead of
  // sharing edges. Crops still use the full cell.
  const OUTLINE_INSET = 3;
  const outlineWidth = cellWidth - OUTLINE_INSET;
  const outlineHeight = cellHeight - OUTLINE_INSET;
  // Detected hits use an even square — easier to read than the cell's natural
  // rectangle. Red unresolved boxes keep the cell shape so they still tile.
  const greenSide = Math.min(outlineWidth, outlineHeight);

  // Everything the scan wants to report as a miss, minus the slots a later match
  // has since covered and the icons the user has marked as not being ours. Built
  // once so the outlines and the teach crops always agree.
  const ignoredSignatures = loadIgnored();
  const reportable: {
    cell: number;
    guess: LoadedTarget | null;
    centreX: number;
    centreY: number;
    left: number;
    top: number;
    signature: string;
  }[] = [];
  for (const [index, cell] of unresolvedCells.entries()) {
    const covered = slots.some(
      (slot) =>
        Math.abs(slot.x + slot.target.image.width / 2 - cell.x) < SLOT_RADIUS &&
        Math.abs(slot.y + slot.target.image.height / 2 - cell.y) < SLOT_RADIUS,
    );
    if (covered) continue;
    if (isBlankCell(cell.x, cell.y)) continue;

    const centreX = snapToLattice(cell.x, latticeX);
    const centreY = snapToLattice(cell.y, latticeY);
    const left = Math.round(centreX - cellWidth / 2);
    const top = Math.round(centreY - cellHeight / 2);
    const signature = cellSignature(pixels, left, top, cellWidth, cellHeight);
    if (isIgnored(signature, ignoredSignatures)) continue;

    reportable.push({ cell: index, guess: cell.guess, centreX, centreY, left, top, signature });
  }

  if (debugOverlay && typeof alt1 !== "undefined" && alt1.permissionOverlay) {
    const group = "archaeology-companion-scan";
    alt1.overLayFreezeGroup(group);
    alt1.overLayClearGroup(group);
    alt1.overLaySetGroup(group);
    alt1.overLaySetGroupZIndex(group, 2);

    const green = a1lib.mixColor(70, 220, 80);
    const red = a1lib.mixColor(235, 55, 45);
    const gold = a1lib.mixColor(240, 190, 121);
    // Alt1's overlay bridge only accepts ints — averaged slot centres are floats.
    const rect = (color: number, x: number, y: number, w: number, h: number): void => {
      alt1.overLayRect(
        color,
        Math.round(x),
        Math.round(y),
        Math.round(w),
        Math.round(h),
        debugOverlayMs,
        debugOverlayWidth,
      );
    };
    const boxAt = (
      color: number,
      centreX: number,
      centreY: number,
      width: number,
      height: number,
    ): void => {
      const x = snapToLattice(centreX, latticeX);
      const y = snapToLattice(centreY, latticeY);
      rect(color, x - width / 2, y - height / 2, width, height);
    };
    rect(gold, detected.title.x - 2, detected.title.y - 2, detected.title.width + 4, detected.title.height + 4);
    for (const slot of slots) {
      boxAt(
        green,
        slot.x + slot.target.image.width / 2,
        slot.y + slot.target.image.height / 2,
        greenSide,
        greenSide,
      );
    }
    for (const entry of reportable) {
      boxAt(red, entry.centreX, entry.centreY, outlineWidth, outlineHeight);
    }
    alt1.overLayRefreshGroup(group);
  }

  // Crop every still-unresolved occupied slot so the user can name it. A named
  // crop is stored as a learned sprite and matches directly on the next scan.
  // Live scroll passes skip this — the final thorough pass does the teaching.
  // Edge rows during a scroll are left out: those icons are often cut in half.
  const unresolved: UnresolvedSlot[] = [];
  if (!fast) {
    const hitRowYs = slots.map((slot) => slot.y + slot.target.image.height / 2);
    const teachRows = scrolling && hitRowYs.length ? clusterLine(hitRowYs) : [];
    const edgeTol = Math.max(6, (latticeY?.pitch ?? 32) * 0.3);
    for (const entry of reportable) {
      if (unresolved.length >= MAX_UNRESOLVED_CROPS) break;
      if (teachRows.length > 1) {
        const onEdge =
          Math.abs(entry.centreY - teachRows[0]) <= edgeTol ||
          Math.abs(entry.centreY - teachRows.at(-1)!) <= edgeTol;
        if (onEdge) continue;
      }
      unresolved.push({
        cell: entry.cell,
        dataUrl: cropToDataUrl(pixels, entry.left, entry.top, cellWidth, cellHeight),
        // Stack text sits in the nominal 36x32 slot corner, so it is read from there.
        quantity: readStackQuantity(
          pixels,
          Math.round(entry.centreX - 18),
          Math.round(entry.centreY - 16),
        ),
        signature: entry.signature,
        guessKey: entry.guess ? learnedKeyOf(entry.guess) : null,
        guessName: entry.guess ? targetName(entry.guess) : null,
      });
    }
  }

  onProgress?.(targets.length, targets.length);

  const spatialSlots = [...slots].sort(
    (a, b) =>
      a.y + a.target.image.height / 2 - (b.y + b.target.image.height / 2) ||
      a.x + a.target.image.width / 2 - (b.x + b.target.image.width / 2),
  );
  const keyOf = (target: LoadedTarget): string =>
    target.type === "artefact"
      ? `${target.artefact.id}:${target.kind}`
      : `mat:${target.material.id}`;

  // Lay the diagnostic preview on the fitted lattice from confirmed hits and
  // deferred misses. Miss centres must expand the grid so a dropped icon leaves
  // a red ! hole instead of vanishing (and looking like an empty slot).
  const hitXs = spatialSlots.map((slot) => slot.x + slot.target.image.width / 2);
  const hitYs = spatialSlots.map((slot) => slot.y + slot.target.image.height / 2);
  const missXs = [
    ...reportable.map((entry) => entry.centreX),
    ...deferredMissCentres.map((entry) => entry.x),
  ];
  const missYs = [
    ...reportable.map((entry) => entry.centreY),
    ...deferredMissCentres.map((entry) => entry.y),
  ];
  const columnCentres =
    hitXs.length + missXs.length >= 1
      ? expandFromLattice(latticeX, [...hitXs, ...missXs])
      : [];
  const rowCentres =
    hitYs.length + missYs.length >= 1
      ? expandFromLattice(latticeY, [...hitYs, ...missYs])
      : [];
  // Prefer the stitch walk lattice (full material-storage grid including lock
  // rows) so the debug grid matches what soft matching actually scored.
  const columns =
    stitchGridColumns && stitchGridColumns.length >= 1
      ? stitchGridColumns
      : columnCentres.length >= 1
        ? columnCentres
        : clusterLine([...hitXs, ...missXs]);
  const rows =
    stitchGridRows && stitchGridRows.length >= 1
      ? stitchGridRows
      : rowCentres.length >= 1
        ? rowCentres
        : clusterLine([...hitYs, ...missYs]);
  const nearestIndex = (centres: number[], value: number): number => {
    let best = 0;
    for (let index = 1; index < centres.length; index += 1) {
      if (Math.abs(centres[index] - value) < Math.abs(centres[best] - value)) best = index;
    }
    return best;
  };
  // A miss only belongs on the debug grid when it sits on a real slot centre —
  // within half a pitch of some confirmed lattice line.
  const onItemLattice = (centreX: number, centreY: number): boolean => {
    if (!columns.length || !rows.length) return false;
    const col = columns[nearestIndex(columns, centreX)];
    const row = rows[nearestIndex(rows, centreY)];
    const tolX = (latticeX?.pitch ?? 42) * 0.45;
    const tolY = (latticeY?.pitch ?? 36) * 0.45;
    return Math.abs(col - centreX) <= tolX && Math.abs(row - centreY) <= tolY;
  };
  const gridMisses = reportable.filter((entry) =>
    onItemLattice(entry.centreX, entry.centreY),
  );

  // Soft matching can miss a dark redrawn icon. Walk the lattice (including
  // deferred clip-zone centres) and mark every still-occupied hole as a debug
  // miss with a screen crop — never a blank empty cell.
  const takenDebug = new Set<string>();
  for (const slot of spatialSlots) {
    takenDebug.add(
      `${nearestIndex(rows, slot.y + slot.target.image.height / 2)},${nearestIndex(columns, slot.x + slot.target.image.width / 2)}`,
    );
  }
  for (const entry of gridMisses) {
    takenDebug.add(
      `${nearestIndex(rows, entry.centreY)},${nearestIndex(columns, entry.centreX)}`,
    );
  }
  const holeMisses: typeof gridMisses = [];
  const considerMiss = (centreX: number, centreY: number) => {
    const key = `${nearestIndex(rows, centreY)},${nearestIndex(columns, centreX)}`;
    if (takenDebug.has(key)) return;
    if (isBlankCell(centreX, centreY)) return;
    const content = cellContent(centreX, centreY);
    const ink = readSlot(pixels, centreX, centreY, slotSize);
    if (content === "empty" && ink.count < Math.max(20, SLOT_MIN_INK / 2)) return;
    const left = Math.round(centreX - cellWidth / 2);
    const top = Math.round(centreY - cellHeight / 2);
    const signature = cellSignature(pixels, left, top, cellWidth, cellHeight);
    if (isIgnored(signature, ignoredSignatures)) return;
    holeMisses.push({
      cell: -1,
      guess: null,
      centreX,
      centreY,
      left,
      top,
      signature,
    });
    takenDebug.add(key);
  };
  for (const centreY of rows) {
    for (const centreX of columns) {
      considerMiss(centreX, centreY);
    }
  }
  for (const entry of deferredMissCentres) {
    considerMiss(entry.x, entry.y);
  }
  const debugMisses = [...gridMisses, ...holeMisses];

  const merged = new Map<string, ScanHit>();
  for (const slot of spatialSlots) {
    const { target } = slot;
    const centreX = slot.x + slot.target.image.width / 2;
    const centreY = slot.y + slot.target.image.height / 2;
    // Read digits from the lattice cell corner, not the sprite origin — matching
    // offsets often sit a few px off where the stack text is drawn.
    const quantity = readStackQuantity(
      pixels,
      Math.round(centreX - cellWidth / 2),
      Math.round(centreY - cellHeight / 2),
    );
    // Bank placeholders show quantity 0 — not owned, do not add to the list.
    if (quantity === 0) continue;
    const key = keyOf(target);
    const row = nearestIndex(rows, centreY);
    const onClipRow =
      scrolling && rows.length > 1 && (row === 0 || row === rows.length - 1);
    // Mid-scroll weak soft invents phantom names; settled weak soft (peacocking,
    // godstaff) must still count on one view. Strong soft (≥95%) is always trusted.
    const weakSoftScroll =
      scrolling && !slot.exact && slot.precision < TRUSTED_SOFT_PRECISION;
    const edgeRow = onClipRow || weakSoftScroll;

    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
      existing.exact ||= slot.exact;
      // A full-cell sighting clears an earlier clipped flag.
      existing.edgeRow &&= edgeRow;
    } else if (target.type === "artefact") {
      merged.set(key, {
        type: "artefact",
        artefact: target.artefact,
        kind: target.kind,
        quantity,
        exact: slot.exact,
        edgeRow,
      });
    } else {
      merged.set(key, {
        type: "material",
        material: target.material,
        quantity,
        exact: slot.exact,
        edgeRow,
      });
    }
  }

  const hits = [...merged.values()].sort((a, b) => {
    const nameA = a.type === "artefact" ? a.artefact.name : a.material.name;
    const nameB = b.type === "artefact" ? b.artefact.name : b.material.name;
    return nameA.localeCompare(nameB);
  });

  const debugSlots: DebugSlot[] = [
    ...spatialSlots.map((slot) => {
      const centreX = slot.x + slot.target.image.width / 2;
      const centreY = slot.y + slot.target.image.height / 2;
      return {
        row: nearestIndex(rows, centreY),
        column: nearestIndex(columns, centreX),
        key: keyOf(slot.target),
        name: targetName(slot.target),
        quantity: readStackQuantity(
          pixels,
          Math.round(centreX - cellWidth / 2),
          Math.round(centreY - cellHeight / 2),
        ),
        iconPath: framedIconPath(slot.target),
        kind: "hit" as const,
      };
    }),
    ...debugMisses.map((entry) => ({
      row: nearestIndex(rows, entry.centreY),
      column: nearestIndex(columns, entry.centreX),
      key: `miss:${entry.signature}`,
      name: entry.guess ? targetName(entry.guess) : "Not recognised",
      quantity: readStackQuantity(
        pixels,
        Math.round(entry.centreX - cellWidth / 2),
        Math.round(entry.centreY - cellHeight / 2),
      ),
      iconPath: entry.guess ? framedIconPath(entry.guess) : "",
      kind: "miss" as const,
      cropDataUrl: cropToDataUrl(pixels, entry.left, entry.top, cellWidth, cellHeight),
    })),
  ];

  return {
    mode,
    hits,
    debugSlots,
    debugColumns: Math.max(1, columns.length),
    debugRows: Math.max(1, rows.length),
    debugLayout: providedPixels ? "stitched" : "screen",
    spritesChecked: targets.length,
    durationMs: Math.round(performance.now() - started),
    workbenchDetected: isWorkbench,
    advancedMatching:
      advancedMatching ||
      (Boolean(providedPixels) && (closedSet || detected.kind === "bank")),
    // Closest first, so the most likely genuine misses lead the list.
    nearMisses: nearMisses
      .sort((a, b) => b.precision + b.recall - (a.precision + a.recall))
      .slice(0, 10),
    unresolved,
    // Live scroll passes reuse this. Once the grid is known it is far tighter
    // than the box the title implies, which is where the speed-up comes from.
    searchArea: (slots.length >= 6 ? slotsArea(110) : undefined) ?? detected.area,
    interfaceKind: detected.kind,
  };
};
