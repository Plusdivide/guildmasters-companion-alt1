/**
 * Hover-to-teach — bank tooltip reader (chatbox-style approach)
 *
 * 1. Capture near the cursor
 * 2. Locate the dark tooltip panel (relaxed fill — modern RS isn’t pure black)
 * 3. OCR the gold item name on the title row inside that panel
 * 4. Confirm → learn the stitch crop for the preview cell
 */
import * as a1lib from "alt1/base";
import * as OCR from "alt1/ocr";
import fontAa8 from "alt1/fonts/aa_8px.js";
import fontAa10Mono from "alt1/fonts/aa_10px_mono.js";
import fontAa12Mono from "alt1/fonts/aa_12px_mono.js";
import { archaeologyData } from "./data";
import { matchArtefactText } from "./alt1";
import {
  artefactLearnedKey,
  materialLearnedKey,
  saveLearnedSprite,
} from "./learned";
import {
  cleanOptionsText,
  countOptionsInk,
  fuzzyCatalogueName,
  readOptionsStrip,
} from "./options-ocr";

type OcrFont = OCR.FontDefinition;

const unwrapFont = (value: unknown): OcrFont => {
  let current: unknown = value;
  while (current && typeof current === "object" && "default" in current) {
    current = (current as { default: unknown }).default;
  }
  return current as OcrFont;
};

/** Tooltip fonts (fallback floating-tooltip OCR). */
const FONTS = [
  unwrapFont(fontAa10Mono),
  unwrapFont(fontAa8),
  unwrapFont(fontAa12Mono),
];

/** TooltipReader bank colours (+ a couple of modern golds). */
const BANK_COLS: OCR.ColortTriplet[] = [
  [248, 213, 107],
  [184, 209, 209],
  [255, 255, 0],
  [255, 204, 0],
  [255, 187, 34],
  [235, 224, 188],
];

const SLOT = 36;
const MIN_NAME_LETTERS = 6;

export type TaughtFromTooltip = {
  /** Empty when the read name is not an archaeology artefact/material. */
  key: string;
  label: string;
  quantity: number;
  dataUrl: string;
  trackable: boolean;
};

export type CellTeachGate = {
  row: number;
  column: number;
  screenLeft: number;
  screenTop: number;
  screenWidth: number;
  screenHeight: number;
  cropDataUrl: string;
};

export type CellTeachCallbacks = {
  onTaught: (taught: TaughtFromTooltip) => void;
  onStatus?: (message: string) => void;
  onHud?: (line: string) => void;
};

type Rect = { x: number; y: number; width: number; height: number };

const cropUnderMouse = (mouse: { x: number; y: number }): string | null => {
  const half = Math.floor(SLOT / 2);
  const x = Math.max(0, mouse.x - half);
  const y = Math.max(0, mouse.y - half);
  const img = a1lib.capture(x, y, SLOT, SLOT);
  if (!img) return null;
  const canvas = document.createElement("canvas");
  canvas.width = SLOT;
  canvas.height = SLOT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
};

const cleanHoverName = (raw: string): string => cleanOptionsText(raw);

const letterScore = (text: string): number =>
  (text.match(/[A-Za-z]/g)?.length ?? 0);

const isPlausibleItemName = (text: string): boolean => {
  const cleaned = cleanHoverName(text);
  if (letterScore(cleaned) < MIN_NAME_LETTERS) return false;
  if (letterScore(cleaned) > 48) return false;
  if (!/[A-Za-z]{3,}/.test(cleaned)) return false;
  if (/(.)\1{3,}/i.test(cleaned.replace(/[^A-Za-z]/g, ""))) return false;

  const letters = cleaned.toLowerCase().replace(/[^a-z]/g, "");
  if (letters.length < MIN_NAME_LETTERS) return false;
  const unique = new Set(letters);
  if (unique.size < 5) return false;

  const counts = new Map<string, number>();
  for (const ch of letters) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const top = Math.max(...counts.values());
  if (top / letters.length > 0.35) return false;

  if (!/\s|-|'/.test(cleaned) && letters.length > 18) return false;
  return true;
};

export const parseItemName = (
  name: string,
): { key: string; label: string } | null => {
  const cleaned = cleanHoverName(name);
  if (!cleaned) return null;

  const artefact = matchArtefactText(cleaned, archaeologyData.artefacts);
  if (artefact) {
    const lower = cleaned.toLowerCase();
    const kind: "damaged" | "restored" = /damaged/.test(lower)
      ? "damaged"
      : "restored";
    return {
      key: artefactLearnedKey(artefact.id, kind),
      label: `${artefact.name} (${kind})`,
    };
  }
  const normalized = cleaned
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const material = archaeologyData.materials.find((entry) =>
    normalized.includes(entry.name.toLowerCase()),
  );
  if (material) {
    return {
      key: materialLearnedKey(material.id),
      label: material.name,
    };
  }
  return null;
};

export const mouseInLinkedCell = (
  mouse: { x: number; y: number },
  gate: CellTeachGate,
  slack = 2,
): boolean =>
  mouse.x >= gate.screenLeft - slack &&
  mouse.x < gate.screenLeft + gate.screenWidth + slack &&
  mouse.y >= gate.screenTop - slack &&
  mouse.y < gate.screenTop + gate.screenHeight + slack;

/** Tooltip fills: pure black (legacy) or dark brown (current RS). */
const isTooltipBg = (r: number, g: number, b: number): boolean => {
  if (r + g + b <= 24) return true; // near-pure black
  return r <= 70 && g <= 60 && b <= 55 && r + g + b <= 160 && Math.max(r, g, b) <= 75;
};

/** Frame / name gold (broader than OCR ink). */
const isGoldish = (r: number, g: number, b: number): boolean =>
  r >= 140 && g >= 95 && b <= 170 && r - b >= 25 && g - b >= 5;

const isGoldInk = (r: number, g: number, b: number): boolean =>
  r >= 170 && g >= 110 && b <= 160 && r - b >= 40 && g - b >= 15;

const pixel = (
  img: ImageData,
  x: number,
  y: number,
): [number, number, number] | null => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/**
 * Expand from a dark seed to a rectangular tooltip panel.
 * Same idea as Alt1 TooltipReader.attemptFill, but near-black (not only 0,0,0).
 */
const attemptDarkFill = (
  img: ImageData,
  startX: number,
  startY: number,
): Rect | null => {
  const bg = (x: number, y: number): boolean => {
    const p = pixel(img, x, y);
    return Boolean(p && isTooltipBg(p[0], p[1], p[2]));
  };
  if (!bg(startX, startY)) return null;

  let y1 = startY;
  while (y1 > 0 && bg(startX, y1 - 1)) y1 -= 1;
  let y2 = startY;
  while (y2 < img.height - 1 && bg(startX, y2 + 1)) y2 += 1;

  const midY = Math.floor((y1 + y2) / 2);
  let x1 = startX;
  while (x1 > 0 && bg(x1 - 1, midY)) x1 -= 1;
  let x2 = startX;
  while (x2 < img.width - 1 && bg(x2 + 1, midY)) x2 += 1;

  const midX = Math.floor((x1 + x2) / 2);
  y1 = midY;
  while (y1 > 0 && bg(midX, y1 - 1)) y1 -= 1;
  y2 = midY;
  while (y2 < img.height - 1 && bg(midX, y2 + 1)) y2 += 1;

  const width = x2 - x1 + 1;
  const height = y2 - y1 + 1;
  if (width < 90 || height < 24) return null;
  if (width > 540 || height > 180) return null;
  if (width >= img.width - 2 && height >= img.height - 2) return null;
  return { x: x1, y: y1, width, height };
};

/** Locate via the yellow item-name row when the dark fill is hard to see. */
const findBoxFromGoldNameLine = (img: ImageData): Rect | null => {
  let best: { y: number; x1: number; x2: number; score: number } | null = null;

  // Coarse stride — this path must stay cheap on every poll tick.
  for (let y = 4; y < img.height - 4; y += 3) {
    const xs: number[] = [];
    for (let x = 4; x < img.width - 4; x += 2) {
      const p = pixel(img, x, y);
      if (!p || !isGoldInk(p[0], p[1], p[2])) continue;
      const q = pixel(img, x + 2, y);
      const r = pixel(img, x, y + 1);
      if (
        !(q && isGoldInk(q[0], q[1], q[2])) &&
        !(r && isGoldInk(r[0], r[1], r[2]))
      ) {
        continue;
      }
      xs.push(x);
    }
    if (xs.length < 8) continue;

    let gaps = 0;
    for (let i = 1; i < xs.length; i += 1) {
      if (xs[i] - xs[i - 1] > 6) gaps += 1;
    }
    if (gaps < 2) continue;

    const x1 = xs[0];
    const x2 = xs[xs.length - 1];
    if (x2 - x1 < 60) continue;
    const score = xs.length + gaps * 5;
    if (!best || score > best.score) best = { y, x1, x2, score };
  }

  if (!best) return null;
  const padX = 18;
  const x = Math.max(0, best.x1 - padX);
  const width = Math.min(img.width - x, best.x2 - best.x1 + padX * 2);
  const y = Math.max(0, best.y - 12);
  const height = Math.min(img.height - y, 56);
  if (width < 90 || height < 24) return null;
  return { x, y, width, height };
};

/** Locate via long horizontal gold/tan border strokes. */
const findBoxFromGoldBorder = (img: ImageData): Rect | null => {
  const hRuns: { y: number; x1: number; x2: number }[] = [];
  for (let y = 2; y < img.height - 2; y += 2) {
    let runStart = -1;
    let runLen = 0;
    for (let x = 2; x < img.width - 2; x += 2) {
      const p = pixel(img, x, y);
      const hit = Boolean(p && isGoldish(p[0], p[1], p[2]));
      if (hit) {
        if (runStart < 0) runStart = x;
        runLen += 2;
      } else if (runLen >= 80) {
        hRuns.push({ y, x1: runStart, x2: runStart + runLen - 1 });
        runStart = -1;
        runLen = 0;
      } else {
        runStart = -1;
        runLen = 0;
      }
    }
    if (runLen >= 80 && runStart >= 0) {
      hRuns.push({ y, x1: runStart, x2: runStart + runLen - 1 });
    }
  }

  for (let i = 0; i < hRuns.length; i += 1) {
    const top = hRuns[i];
    for (let j = i + 1; j < hRuns.length; j += 1) {
      const bot = hRuns[j];
      const gap = bot.y - top.y;
      if (gap < 28 || gap > 100) continue;
      const x1 = Math.min(top.x1, bot.x1);
      const x2 = Math.max(top.x2, bot.x2);
      const width = x2 - x1 + 1;
      if (width < 100) continue;
      const overlap =
        Math.min(top.x2, bot.x2) - Math.max(top.x1, bot.x1);
      if (overlap < width * 0.5) continue;
      return {
        x: Math.max(0, x1 - 2),
        y: Math.max(0, top.y - 2),
        width: Math.min(img.width - x1, width + 4),
        height: Math.min(img.height - top.y, gap + 4),
      };
    }
  }
  return null;
};

const boxHasGold = (img: ImageData, box: Rect): boolean => {
  let goldHits = 0;
  for (let y = box.y + 2; y < box.y + Math.min(box.height, 40); y += 2) {
    for (let x = box.x + 6; x < box.x + box.width - 6 && goldHits < 8; x += 3) {
      const c = pixel(img, x, y);
      if (c && isGoldInk(c[0], c[1], c[2])) goldHits += 1;
    }
  }
  return goldHits >= 3;
};

/** Looser than isGoldInk — enough to find glyph pixels for OCR seeds. */
const isNameInk = (r: number, g: number, b: number): boolean => {
  // Gold / yellow title
  if (r >= 150 && g >= 100 && b <= 180 && r - b >= 20 && g - b >= 0) return true;
  // Pale silver / white title (non-members / some tooltips)
  if (r >= 170 && g >= 170 && b >= 150 && Math.abs(r - g) < 40) return true;
  return false;
};

const findTooltipBox = (img: ImageData): Rect | null => {
  const candidates: Rect[] = [];

  // Prefer the gold name line — most specific to an item tooltip.
  const fromLine = findBoxFromGoldNameLine(img);
  if (fromLine) candidates.push(fromLine);

  // Dark panel fill — only tooltip-sized rectangles.
  const xSteps = Math.max(8, Math.ceil(img.width / 16));
  for (let sx = 8; sx < img.width - 8; sx += xSteps) {
    for (let sy = 4; sy < img.height - 4; sy += 4) {
      const p = pixel(img, sx, sy);
      if (!p || !isTooltipBg(p[0], p[1], p[2])) continue;
      const box = attemptDarkFill(img, sx, sy);
      if (!box || !boxHasGold(img, box)) continue;
      // Reject huge bank chrome chunks mistaken for tooltips.
      if (box.height < 26 || box.height > 110) continue;
      if (box.width < 100 || box.width > 480) continue;
      candidates.push(box);
    }
  }

  if (!candidates.length) {
    const fromBorder = findBoxFromGoldBorder(img);
    if (fromBorder && fromBorder.height <= 110) candidates.push(fromBorder);
  }

  if (!candidates.length) return null;

  // Prefer compact boxes with a gold title band (real tooltips), not bank panels.
  const score = (box: Rect): number => {
    let gold = 0;
    const yMax = box.y + Math.min(box.height, 28);
    for (let y = box.y + 4; y < yMax; y += 2) {
      for (let x = box.x + 8; x < box.x + box.width - 8; x += 3) {
        const p = pixel(img, x, y);
        if (p && isNameInk(p[0], p[1], p[2])) gold += 1;
      }
    }
    // Smaller is better once gold is present; penalise gold-less boxes.
    return gold * 1000 - box.width * box.height;
  };

  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0];
};

/** Prefer catalogue hits even when OCR is messy. */
const catalogueHit = (raw: string): string => {
  const cleaned = cleanHoverName(raw);
  if (!cleaned) return "";
  if (parseItemName(cleaned)) return cleaned;
  const norm = cleaned
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\(damaged\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (norm.length < 4) return "";

  let best = "";
  let bestScore = 0;
  for (const artefact of archaeologyData.artefacts) {
    for (const name of [artefact.name, artefact.damagedName]) {
      const n = name
        .toLowerCase()
        .replace(/[’']/g, "'")
        .replace(/[^a-z0-9' -]/g, " ")
        .replace(/\s*\(damaged\)\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!n) continue;
      if (norm.includes(n) || (n.includes(norm) && norm.length >= 6)) {
        if (n.length > bestScore) {
          best = name;
          bestScore = n.length;
        }
        continue;
      }
      const tokens = n.split(" ").filter((t) => t.length > 2);
      if (!tokens.length) continue;
      const hits = tokens.filter((t) => norm.includes(t)).length;
      if (hits / tokens.length >= 0.65 && hits * 3 > bestScore) {
        best = name;
        bestScore = hits * 3;
      }
    }
  }
  for (const material of archaeologyData.materials) {
    const n = material.name.toLowerCase();
    if (norm.includes(n) && n.length > bestScore) {
      best = material.name;
      bestScore = n.length;
    }
  }
  return best ? cleanHoverName(best) : "";
};

/** Drop obvious OCR garbage; keep imperfect names for catalogue matching. */
const softAccept = (raw: string): string => {
  if (!raw) return "";
  // bindReadStringEx JSON must never become a “name”.
  if (raw.trimStart().startsWith("{")) return "";
  if (/fragments|fontname|allowgap/i.test(raw) && /[{}]/.test(raw)) return "";
  const cleaned = cleanHoverName(raw);
  if (letterScore(cleaned) < 3) return "";
  const letters = cleaned.replace(/[^A-Za-z]/g, "");
  if (/(.)\1{5,}/i.test(letters)) return "";
  return cleaned;
};

const acceptRead = (raw: string): string => {
  const cleaned = softAccept(raw);
  if (!cleaned) return "";
  const hit =
    catalogueHit(cleaned) ||
    fuzzyCatalogueName(cleaned) ||
    fuzzyCatalogueName(raw);
  if (hit) return hit;
  if (isPlausibleItemName(cleaned)) return cleaned;
  // Allow shorter OCR for catalogue/manual flow.
  if (letterScore(cleaned) >= 6 && /[A-Za-z]{3,}/.test(cleaned)) return cleaned;
  return "";
};

/** Alt1 bindReadStringEx often returns JSON with text fragments. */
const unwrapBindRead = (raw: string): string => {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(trimmed) as {
      text?: string;
      fragments?: { text?: string }[];
    };
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      return parsed.text;
    }
    if (Array.isArray(parsed.fragments)) {
      return parsed.fragments.map((f) => f.text ?? "").join("");
    }
  } catch {
    // not JSON
  }
  return raw;
};

/** Capture the top-left options strip (same buffer bank scan uses when possible). */
const captureOptionsStrip = (
  width: number,
  height: number,
): ImageData | null => {
  try {
    const hold = a1lib.captureHoldFullRs?.();
    if (hold && typeof hold.toData === "function") {
      const full = hold.toData(0, 0, width, height);
      if (full?.data) return full;
    }
  } catch {
    // fall through
  }
  try {
    return a1lib.capture(0, 0, width, height);
  } catch {
    return null;
  }
};

/**
 * Read the mouseover / options line at the top-left of the RS client.
 * Sync Alt1/sprite OCR first; callers that can await should use the async path.
 */
export const readTopLeftOptionsName = (): {
  name: string;
  raw: string;
  ink: number;
} => {
  const alt1 = typeof window !== "undefined" ? window.alt1 : undefined;
  const rsW = alt1?.rsWidth ?? 800;
  const width = Math.min(820, Math.max(400, rsW - 4));
  const height = 36;

  let bestRaw = "";
  const consider = (text: string): void => {
    const unwrapped = unwrapBindRead(text);
    const soft = softAccept(unwrapped);
    if (!soft) return;
    if (letterScore(soft) > letterScore(bestRaw)) bestRaw = soft;
  };

  const img = captureOptionsStrip(width, height);
  const ink = img?.data ? countOptionsInk(img) : 0;

  // Shared JS OCR path.
  if (img?.data) {
    const js = readOptionsStrip(img, { maxAttempts: 100 });
    consider(js.name);
    consider(js.raw);
    if (letterScore(bestRaw) >= 10) {
      return { name: acceptRead(bestRaw), raw: bestRaw, ink };
    }
  }

  // Native Alt1 OCR — prefer preset colours, then yellow/white singles.
  if (alt1?.bindRegion) {
    try {
      const id = alt1.bindRegion(0, 0, width, height);
      if (id > 0) {
        const yellow = a1lib.mixColor(255, 255, 0);
        const gold = a1lib.mixColor(248, 213, 107);
        const white = a1lib.mixColor(255, 255, 255);
        const cyan = a1lib.mixColor(0, 255, 255);
        let attempts = 0;
        outer: for (const font of ["chat", "chatmono"]) {
          for (const y of [8, 10, 12, 14, 16, 18, 20]) {
            for (const x of [8, 20, 40, 60, 80, 110, 150, 200]) {
              attempts += 1;
              if (attempts > 48) break outer;

              // Default preset colours (often better than a hand-picked list).
              if (alt1.bindReadString) {
                consider(alt1.bindReadString(id, font, x, y) ?? "");
              }
              if (alt1.bindReadColorString) {
                for (const color of [yellow, gold, white, cyan]) {
                  consider(
                    alt1.bindReadColorString(id, font, color, x, y) ?? "",
                  );
                }
              }
              if (alt1.bindReadStringEx) {
                consider(
                  alt1.bindReadStringEx(
                    id,
                    x,
                    y,
                    JSON.stringify({
                      fontname: font,
                      colors: [yellow, gold, white, cyan],
                      allowgap: true,
                    }),
                  ) ?? "",
                );
              }
              if (letterScore(bestRaw) >= 12 && catalogueHit(bestRaw)) {
                break outer;
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return { name: acceptRead(bestRaw), raw: bestRaw, ink };
};

/**
 * Same as readTopLeftOptionsName, then tesseract + catalogue fuzzy match
 * (the offline recipe that reads Yurkolgokh from screenshots).
 */
export const readTopLeftOptionsNameAsync = async (): Promise<{
  name: string;
  raw: string;
  ink: number;
}> => {
  const sync = readTopLeftOptionsName();
  if (sync.name && parseItemName(sync.name)) return sync;
  if (sync.name && letterScore(sync.name) >= 10) return sync;

  const alt1 = typeof window !== "undefined" ? window.alt1 : undefined;
  const rsW = alt1?.rsWidth ?? 800;
  const width = Math.min(820, Math.max(400, rsW - 4));
  const height = 36;
  const img = captureOptionsStrip(width, height);
  if (!img?.data) return sync;

  try {
    const { readOptionsStripTesseract } = await import("./options-tesseract");
    const tess = await readOptionsStripTesseract(img);
    const softRaw = softAccept(tess.raw) || softAccept(tess.name) || tess.raw;
    const name =
      acceptRead(tess.name) ||
      acceptRead(tess.raw) ||
      fuzzyCatalogueName(tess.name) ||
      fuzzyCatalogueName(tess.raw) ||
      fuzzyCatalogueName(softRaw);
    if (name || letterScore(softRaw) > letterScore(sync.raw)) {
      return {
        name: name || acceptRead(softRaw),
        raw: softRaw || sync.raw,
        ink: Math.max(sync.ink, tess.inkCount),
      };
    }
  } catch {
    // keep sync result
  }
  return sync;
};

/** Y of the densest name-ink row in the title band. */
const findGoldNameBaseline = (img: ImageData, box: Rect): number | null => {
  let bestY: number | null = null;
  let bestHits = 0;
  const yMax = box.y + Math.min(box.height - 2, 36);
  for (let y = box.y + 6; y <= yMax; y += 1) {
    let hits = 0;
    for (let x = box.x + 8; x < box.x + box.width - 8; x += 2) {
      const p = pixel(img, x, y);
      if (p && isNameInk(p[0], p[1], p[2])) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestY = y;
    }
  }
  return bestHits >= 5 ? bestY : null;
};

/**
 * Same idea as bank stack OCR in scanner.ts:
 * find bright ink pixels, seed findReadLine *inside* glyphs, use the sampled colour.
 */
const readNameInsideBox = (
  img: ImageData,
  box: Rect,
): { name: string; raw: string } => {
  let bestRaw = "";
  const tryRaw = (text: string): void => {
    const soft = softAccept(text);
    if (letterScore(soft) > letterScore(bestRaw)) bestRaw = soft;
  };

  const titleTop = box.y + 4;
  const titleBottom = box.y + Math.min(box.height - 2, 34);

  // Collect ink pixels in the title band.
  const ink: { x: number; y: number; r: number; g: number; b: number }[] = [];
  for (let y = titleTop; y <= titleBottom; y += 1) {
    for (let x = box.x + 8; x < box.x + box.width - 8; x += 2) {
      const p = pixel(img, x, y);
      if (!p || !isNameInk(p[0], p[1], p[2])) continue;
      ink.push({ x, y, r: p[0], g: p[1], b: p[2] });
      if (ink.length >= 120) break;
    }
    if (ink.length >= 120) break;
  }

  const midX = box.x + Math.floor(box.width / 2);
  const goldY = findGoldNameBaseline(img, box) ?? box.y + 14;

  // Seed points: ink centroids first (critical), then Alt1 bank defaults.
  const seeds: { x: number; y: number; cols: OCR.ColortTriplet[] }[] = [];

  if (ink.length >= 5) {
    const cx = Math.round(ink.reduce((s, p) => s + p.x, 0) / ink.length);
    const cy = Math.round(ink.reduce((s, p) => s + p.y, 0) / ink.length);
    const byBright = [...ink].sort((a, b) => b.r + b.g - (a.r + a.g));
    const sampled: OCR.ColortTriplet[] = [];
    const seen = new Set<string>();
    for (const p of byBright) {
      const k = `${p.r >> 3},${p.g >> 3},${p.b >> 3}`;
      if (seen.has(k)) continue;
      seen.add(k);
      sampled.push([p.r, p.g, p.b]);
      if (sampled.length >= 4) break;
    }
    const cols = [...sampled, ...BANK_COLS];
    // Sweep down from ink mass toward the font baseline (same as stack OCR).
    for (const dy of [0, 2, 3, 4]) {
      for (const dx of [0, -16, 16, -40]) {
        seeds.push({ x: cx + dx, y: cy + dy, cols });
      }
    }
    for (const p of byBright.slice(0, 4)) {
      seeds.push({
        x: p.x,
        y: p.y + 2,
        cols: [[p.r, p.g, p.b], ...BANK_COLS],
      });
    }
  }

  // Official TooltipReader.readBankItem seeds as fallback.
  for (const x of [midX + 20, midX, midX - 20, box.x + 16, box.x + 40]) {
    seeds.push({ x, y: goldY, cols: BANK_COLS });
    seeds.push({ x, y: box.y + 14, cols: BANK_COLS });
  }

  let attempts = 0;
  const maxAttempts = 48;

  for (const font of FONTS) {
    for (const seed of seeds) {
      if (seed.y < 2 || seed.y >= img.height - 2) continue;
      if (seed.x < 2 || seed.x >= img.width - 2) continue;
      attempts += 1;
      if (attempts > maxAttempts) {
        return { name: acceptRead(bestRaw), raw: bestRaw };
      }
      try {
        // Narrow vertical band, wide enough horizontally — matches working stack OCR.
        const line = OCR.findReadLine(
          img,
          font,
          seed.cols,
          seed.x,
          seed.y,
          Math.max(24, font.width + font.spacewidth),
          2,
        );
        tryRaw(line?.text ?? "");
      } catch {
        // next
      }
      if (letterScore(bestRaw) >= 8 && catalogueHit(bestRaw)) {
        return { name: acceptRead(bestRaw), raw: bestRaw };
      }
      if (letterScore(bestRaw) >= 14) {
        return { name: acceptRead(bestRaw), raw: bestRaw };
      }
    }
  }

  return { name: acceptRead(bestRaw), raw: bestRaw };
};

export type TooltipProbe = {
  name: string;
  /** Best OCR string before catalogue filters (for HUD). */
  raw: string;
  /** True when a dark tooltip panel was located near the cursor. */
  boxFound: boolean;
  /** Where the usable name came from. */
  source: "options" | "tooltip" | "none";
  /** Gold/white ink pixels in the options strip (0 = text not in capture). */
  optionsInk?: number;
};

const finalizeProbeName = (
  bestName: string,
  bestRaw: string,
): string => {
  const fromRaw = catalogueHit(bestRaw) || acceptRead(bestRaw);
  return (
    (bestName &&
    (parseItemName(bestName) ||
      isPlausibleItemName(bestName) ||
      letterScore(bestName) >= 6)
      ? bestName
      : "") ||
    (fromRaw &&
    (parseItemName(fromRaw) ||
      isPlausibleItemName(fromRaw) ||
      letterScore(fromRaw) >= 6)
      ? fromRaw
      : "")
  );
};

/**
 * Primary teach reader: top-left mouseover / options strip.
 */
export const probeTopLeftOptions = (): TooltipProbe => {
  const read = readTopLeftOptionsName();
  const name = finalizeProbeName(read.name, read.raw);
  return {
    name,
    raw: read.raw,
    boxFound: Boolean(read.raw) || read.ink >= 20,
    source: name ? "options" : read.raw || read.ink >= 20 ? "options" : "none",
    optionsInk: read.ink,
  };
};

/** Async options reader — includes in-app tesseract + fuzzy catalogue match. */
export const probeTopLeftOptionsAsync = async (): Promise<TooltipProbe> => {
  const read = await readTopLeftOptionsNameAsync();
  const name = finalizeProbeName(read.name, read.raw);
  return {
    name,
    raw: read.raw,
    boxFound: Boolean(read.raw) || read.ink >= 20,
    source: name ? "options" : read.raw || read.ink >= 20 ? "options" : "none",
    optionsInk: read.ink,
  };
};

/**
 * Fallback: locate tooltip box near the mouse, then read its name.
 */
export const probeBankTooltip = (
  mouse: { x: number; y: number } | null,
): TooltipProbe => {
  if (!mouse) return { name: "", raw: "", boxFound: false, source: "none" };

  const bands = [
    { x: mouse.x - 40, y: mouse.y - 110, w: 440, h: 130 },
    { x: mouse.x + 8, y: mouse.y - 40, w: 400, h: 100 },
  ];

  let boxFound = false;
  let bestName = "";
  let bestRaw = "";

  for (const band of bands) {
    const sx = Math.max(0, Math.round(band.x));
    const sy = Math.max(0, Math.round(band.y));
    let img: ImageData | null = null;
    try {
      img = a1lib.capture(sx, sy, band.w, band.h);
    } catch {
      continue;
    }
    if (!img?.data) continue;

    const realBox = findTooltipBox(img);
    if (realBox) boxFound = true;
    const useBox =
      realBox ??
      ({
        x: 8,
        y: 4,
        width: Math.min(img.width - 16, 360),
        height: 48,
      } as Rect);

    const read = readNameInsideBox(img, useBox);
    if (letterScore(read.raw) > letterScore(bestRaw)) bestRaw = read.raw;
    if (letterScore(read.name) > letterScore(bestName)) bestName = read.name;
    if (realBox || letterScore(bestRaw) >= 6) break;
  }

  const usable = finalizeProbeName(bestName, bestRaw);
  return {
    name: usable,
    raw: bestRaw,
    boxFound: boxFound || Boolean(bestRaw),
    source: usable ? "tooltip" : "none",
  };
};

/** Options strip first (async tesseract); floating tooltip only if that misses. */
export const probeHoverItemAsync = async (
  mouse: { x: number; y: number } | null,
): Promise<TooltipProbe> => {
  const options = await probeTopLeftOptionsAsync();
  if (options.name && parseItemName(options.name)) return options;
  if (options.name && letterScore(options.name) >= 8) return options;
  if (letterScore(options.raw) >= 6) {
    return { ...options, name: "", source: "options" };
  }

  const tip = probeBankTooltip(mouse);
  if (tip.name) return tip;

  return {
    name: "",
    raw: tip.raw || options.raw,
    boxFound: tip.boxFound || options.boxFound,
    source: options.raw || (options.optionsInk ?? 0) >= 20
      ? "options"
      : tip.boxFound
        ? "tooltip"
        : "none",
    optionsInk: options.optionsInk,
  };
};

/** Options strip first; floating tooltip only if that misses. */
export const probeHoverItem = (
  mouse: { x: number; y: number } | null,
): TooltipProbe => {
  const options = probeTopLeftOptions();
  if (options.name && parseItemName(options.name)) return options;
  if (options.name && letterScore(options.name) >= 8) return options;
  // Show partial options OCR in the HUD before spending time on tooltips.
  if (letterScore(options.raw) >= 6) {
    return { ...options, name: "", source: "options" };
  }

  const tip = probeBankTooltip(mouse);
  if (tip.name) return tip;

  return {
    name: "",
    raw: tip.raw || options.raw,
    boxFound: tip.boxFound || options.boxFound,
    source: options.raw || (options.optionsInk ?? 0) >= 20
      ? "options"
      : tip.boxFound
        ? "tooltip"
        : "none",
    optionsInk: options.optionsInk,
  };
};

export const readBankTooltipName = (
  mouse: { x: number; y: number } | null,
): string => probeHoverItem(mouse).name;

export const readTopLeftHoverName = (): string => probeTopLeftOptions().name;

export type HoverNameRead = {
  name: string;
  source: "options" | "tooltip" | "none";
};

export const readHoverItemName = (
  mouse: { x: number; y: number } | null,
): HoverNameRead => {
  const probe = probeHoverItem(mouse);
  if (probe.name) return { name: probe.name, source: probe.source };
  return { name: "", source: "none" };
};

let pollTimer: number | null = null;
let pollBusy = false;
let lastTaughtKey = "";
let lastTaughtAt = 0;
let lastHudAt = 0;

export const isHoverTeachActive = (): boolean => pollTimer !== null;

export const stopHoverTeach = (): void => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  pollBusy = false;
  lastTaughtKey = "";
  lastTaughtAt = 0;
  lastHudAt = 0;
};

const alt1Ready = (): boolean =>
  typeof window !== "undefined" &&
  Boolean(window.alt1) &&
  typeof a1lib.capture === "function";

const safeMousePosition = (): { x: number; y: number } | null => {
  if (!window.alt1?.permissionGameState) return null;
  if (typeof a1lib.getMousePosition !== "function") return null;
  try {
    return a1lib.getMousePosition();
  } catch {
    return null;
  }
};

const beginPoll = (
  tick: () => void | Promise<void>,
  onStatus?: (message: string) => void,
): boolean => {
  stopHoverTeach();
  if (!alt1Ready()) {
    onStatus?.("Open this app in Alt1 to teach icons.");
    return false;
  }
  if (!window.alt1?.permissionPixel) {
    onStatus?.("Enable “View screen” in the Alt1 app settings.");
    return false;
  }
  if (!window.alt1.permissionGameState) {
    onStatus?.(
      "Enable “Get game state” in Alt1 settings so the mouse can be tracked.",
    );
  }
  void import("./options-tesseract")
    .then((mod) => mod.warmOptionsTesseract())
    .catch(() => {
      // OCR worker is optional until the first read.
    });
  const safeTick = (): void => {
    if (pollBusy) return;
    pollBusy = true;
    void Promise.resolve()
      .then(() => tick())
      .catch((error: unknown) => {
        const raw = error instanceof Error ? error.message : String(error);
        if (/No permission|permission/i.test(raw)) {
          onStatus?.(
            "Enable “View screen” and “Get game state” in Alt1 settings.",
          );
          return;
        }
        onStatus?.("Couldn’t read the tooltip — try hovering again.");
      })
      .finally(() => {
        pollBusy = false;
      });
  };
  // Tesseract needs a bit more room between captures than sprite OCR alone.
  pollTimer = window.setInterval(safeTick, 700);
  window.setTimeout(safeTick, 80);
  return true;
};

const pushHud = (callbacks: CellTeachCallbacks, line: string): void => {
  const now = performance.now();
  if (!line.startsWith("Found") && now - lastHudAt < 280) return;
  lastHudAt = now;
  callbacks.onHud?.(line);
  callbacks.onStatus?.(line);
};

export const startHoverTeach = (
  onTaught: (taught: TaughtFromTooltip) => void,
  onStatus?: (message: string) => void,
): void => {
  if (
    !beginPoll(async () => {
      const mouse = safeMousePosition();
      if (!mouse) return;

      const probe = await probeHoverItemAsync(mouse);
      const cleaned = probe.name;
      if (!cleaned) return;

      const parsed = parseItemName(cleaned);
      if (!parsed) {
        onStatus?.(`“${cleaned}” isn’t a trackable item.`);
        return;
      }

      const now = performance.now();
      if (parsed.key === lastTaughtKey && now - lastTaughtAt < 2500) return;

      const dataUrl = cropUnderMouse(mouse);
      if (!dataUrl) return;

      saveLearnedSprite(parsed.key, dataUrl);
      lastTaughtKey = parsed.key;
      lastTaughtAt = now;
      onTaught({
        key: parsed.key,
        label: parsed.label,
        quantity: 1,
        dataUrl,
        trackable: true,
      });
    }, onStatus)
  ) {
    return;
  }

  onStatus?.("Hover an unmatched icon so the top-left name appears.");
};

export const startCellHoverTeach = (
  gate: CellTeachGate,
  onTaughtOrCallbacks: ((taught: TaughtFromTooltip) => void) | CellTeachCallbacks,
  onStatus?: (message: string) => void,
  _placeLabel = "storage",
): void => {
  const callbacks: CellTeachCallbacks =
    typeof onTaughtOrCallbacks === "function"
      ? { onTaught: onTaughtOrCallbacks, onStatus }
      : onTaughtOrCallbacks;

  if (
    !beginPoll(async () => {
      const mouse = safeMousePosition();
      if (!mouse) {
        pushHud(callbacks, "Hover the matching slot in your bank.");
        return;
      }

      if (!mouseInLinkedCell(mouse, gate)) {
        pushHud(callbacks, "Move onto that bank slot.");
        return;
      }

      pushHud(callbacks, "Reading top-left name…");
      const probe = await probeHoverItemAsync(mouse);
      const label = softAccept(probe.name) || softAccept(probe.raw);
      if (!label || letterScore(label) < 6) {
        if (probe.raw && letterScore(softAccept(probe.raw)) >= 3) {
          pushHud(callbacks, `Saw “${softAccept(probe.raw)}” — keep hovering…`);
        } else if ((probe.optionsInk ?? 0) >= 20) {
          pushHud(callbacks, "Top-left text is visible but unread — keep hovering…");
        } else {
          pushHud(
            callbacks,
            "Hover the slot until the top-left options text shows the item name…",
          );
        }
        return;
      }

      const parsed = parseItemName(label);
      const now = performance.now();
      const dedupeKey = parsed?.key ?? `raw:${label.toLowerCase()}`;
      if (dedupeKey === lastTaughtKey && now - lastTaughtAt < 2500) return;

      lastTaughtKey = dedupeKey;
      lastTaughtAt = now;
      pushHud(
        callbacks,
        parsed ? `Found “${parsed.label}”` : `Read “${label}”`,
      );
      callbacks.onTaught({
        key: parsed?.key ?? "",
        label: parsed?.label ?? label,
        quantity: 1,
        dataUrl: gate.cropDataUrl,
        trackable: Boolean(parsed),
      });
    }, callbacks.onStatus)
  ) {
    return;
  }

  pushHud(
    callbacks,
    "Hover that bank slot — watch for the name in the top-left of the game.",
  );
};
