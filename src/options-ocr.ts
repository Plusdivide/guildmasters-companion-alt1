/**
 * Pure options-strip OCR (top-left “Withdraw-1 Item name / N more options”).
 * Works offline on ImageData and in-app on Alt1 captures — no window.alt1 here.
 */
import * as OCR from "alt1/ocr";
import fontAa8 from "alt1/fonts/aa_8px.js";
import fontAa10Mono from "alt1/fonts/aa_10px_mono.js";
import fontAa12Mono from "alt1/fonts/aa_12px_mono.js";
import fontChat10 from "alt1/fonts/chatbox/10pt.js";
import fontChat12 from "alt1/fonts/chatbox/12pt.js";
import fontChat14 from "alt1/fonts/chatbox/14pt.js";
import rawArchaeology from "./data/archaeology.json" with { type: "json" };
import type { ArchaeologyData } from "./types";

const archaeologyData = rawArchaeology as ArchaeologyData;

type OcrFont = OCR.FontDefinition;
export type ColortTriplet = OCR.ColortTriplet;

const unwrapFont = (value: unknown): OcrFont => {
  let current: unknown = value;
  while (current && typeof current === "object" && "default" in current) {
    current = (current as { default: unknown }).default;
  }
  return current as OcrFont;
};

const FONTS: { name: string; font: OcrFont }[] = [
  { name: "chat12", font: unwrapFont(fontChat12) },
  { name: "chat10", font: unwrapFont(fontChat10) },
  { name: "chat14", font: unwrapFont(fontChat14) },
  { name: "aa10", font: unwrapFont(fontAa10Mono) },
  { name: "aa8", font: unwrapFont(fontAa8) },
  { name: "aa12", font: unwrapFont(fontAa12Mono) },
];

/**
 * RS3 mouseover strip is multi-coloured:
 * action + item name (yellow/gold) · “more options” (white).
 * Keep a wide set — live pixels vary with gamma / lighting.
 */
export const OPTIONS_COLOURS: { name: string; rgb: ColortTriplet }[] = [
  { name: "yellow", rgb: [255, 255, 0] },
  { name: "gold", rgb: [248, 213, 107] },
  { name: "gold2", rgb: [230, 215, 152] },
  { name: "orange", rgb: [255, 187, 34] },
  { name: "amber", rgb: [255, 200, 80] },
  { name: "cream", rgb: [235, 224, 188] },
  { name: "cyan", rgb: [0, 255, 255] },
  { name: "pale-cyan", rgb: [160, 220, 255] },
  { name: "silver", rgb: [184, 209, 209] },
  { name: "white", rgb: [255, 255, 255] },
];

export const cleanOptionsText = (raw: string): string =>
  String(raw ?? "")
    .replace(
      /^\s*(withdraw|deposit|offer|buy|sell|use|wear|wield|eat|drink|empty|drop|examine|cast|take|remove)-\d*\s*/i,
      "",
    )
    .replace(
      /^\s*(withdraw|deposit|offer|buy|sell|use|wear|wield|eat|drink|empty|drop|examine|cast|take|remove)\s+/i,
      "",
    )
    // Normal: “ / 7 more options”, “+7 options”
    .replace(/\s*\/\s*\d+\s*more\s*options?.*$/i, "")
    .replace(/\s*\+\d+\s*options?.*$/i, "")
    .replace(/\s*-\s*\d+\s*more\s*options?.*$/i, "")
    // OCR mush: “/ fimoreoptions”, “[flmoreoptions]”, “imore options”
    .replace(/\s*\/\s*[a-z0-9]*more[a-z0-9]*\s*$/i, "")
    .replace(/\s*\[[^\]]*more[^\]]*\]\s*$/i, "")
    .replace(/\s+[a-z0-9]*more[a-z0-9]*options?[a-z0-9]*\s*$/i, "")
    .replace(/\s+[a-z0-9]*more\s*options?[a-z0-9]*\s*$/i, "")
    .replace(/\s*\[+\s*[a-z0-9]*more[a-z0-9]*\s*\]+\s*$/i, "")
    .replace(/\s*[*★]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const letterScore = (text: string): number =>
  (text.match(/[A-Za-z]/g)?.length ?? 0);

export type OptionsReadHit = {
  raw: string;
  cleaned: string;
  font: string;
  colour: string;
  x: number;
  y: number;
  score: number;
};

export type OptionsReadResult = {
  name: string;
  raw: string;
  hits: OptionsReadHit[];
  inkCount: number;
};

const pixel = (
  img: ImageData,
  x: number,
  y: number,
): [number, number, number] | null => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** Yellow/gold options action+name ink (not muddy mid-greys). */
export const isOptionsGoldInk = (r: number, g: number, b: number): boolean => {
  const sum = r + g + b;
  if (sum < 420) return false;
  if (r < 160 || g < 120) return false;
  // Prefer yellow/gold: r and g high, b lower.
  if (r - b < 25 || g - b < 10) return false;
  return true;
};

/** White “more options” / action ink. */
export const isOptionsWhiteInk = (r: number, g: number, b: number): boolean => {
  if (r < 200 || g < 200 || b < 190) return false;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return sat <= 40;
};

export const isOptionsInk = (r: number, g: number, b: number): boolean =>
  isOptionsGoldInk(r, g, b) || isOptionsWhiteInk(r, g, b);

/** Count bright options-ink pixels — used to gate fixture dumps. */
export const countOptionsInk = (img: ImageData): number => {
  let n = 0;
  const xMax = Math.min(img.width, 700);
  for (let y = 2; y < img.height - 2; y += 1) {
    for (let x = 2; x < xMax; x += 2) {
      const p = pixel(img, x, y);
      if (p && isOptionsInk(p[0], p[1], p[2])) n += 1;
    }
  }
  return n;
};

const sampleNearbyColours = (
  img: ImageData,
  cx: number,
  cy: number,
): ColortTriplet[] => {
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let dy = -2; dy <= 4; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const p = pixel(img, cx + dx, cy + dy);
      if (!p || !isOptionsInk(p[0], p[1], p[2])) continue;
      const key = `${p[0] >> 3},${p[1] >> 3},${p[2] >> 3}`;
      const prev = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      prev.n += 1;
      prev.r += p[0];
      prev.g += p[1];
      prev.b += p[2];
      buckets.set(key, prev);
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map(
      (c) =>
        [
          Math.round(c.r / c.n),
          Math.round(c.g / c.n),
          Math.round(c.b / c.n),
        ] as ColortTriplet,
    );
};

/** Find Y rows that look like glyph ink (bright yellow/white on dark). */
export const findOptionsBaselines = (img: ImageData): number[] => {
  const scores: { y: number; n: number }[] = [];
  for (let y = 2; y < img.height - 2; y += 1) {
    let n = 0;
    for (let x = 4; x < Math.min(img.width - 4, 640); x += 2) {
      const p = pixel(img, x, y);
      if (p && isOptionsInk(p[0], p[1], p[2])) n += 1;
    }
    if (n >= 4) scores.push({ y, n });
  }
  scores.sort((a, b) => b.n - a.n);
  const ys = scores.slice(0, 8).map((s) => s.y);
  for (const fallback of [8, 10, 12, 14, 16, 18, 20]) {
    if (fallback < img.height - 2 && !ys.includes(fallback)) ys.push(fallback);
  }
  return ys;
};

/**
 * Brute-force OCR recipes against an options strip ImageData.
 * Prefer seeding inside sampled ink (same idea as bank stack OCR).
 */
export const readOptionsStrip = (
  img: ImageData,
  opts: { maxAttempts?: number; expect?: RegExp } = {},
): OptionsReadResult => {
  const maxAttempts = opts.maxAttempts ?? 140;
  const hits: OptionsReadHit[] = [];
  let bestRaw = "";
  let bestClean = "";
  let attempts = 0;
  const inkCount = countOptionsInk(img);

  const consider = (
    text: string,
    meta: { font: string; colour: string; x: number; y: number },
  ): void => {
    if (!text) return;
    // Never treat bindReadStringEx JSON as a name.
    if (text.trimStart().startsWith("{")) return;
    const cleaned = cleanOptionsText(text);
    const score = letterScore(cleaned) * 3 + letterScore(text);
    if (score < 6) return;
    hits.push({ raw: text, cleaned, ...meta, score });
    if (letterScore(cleaned) > letterScore(bestClean)) {
      bestClean = cleaned;
      bestRaw = cleaned || text;
    } else if (
      letterScore(cleaned) === letterScore(bestClean) &&
      cleaned.length > bestClean.length
    ) {
      bestClean = cleaned;
      bestRaw = cleaned;
    }
    if (opts.expect?.test(cleaned) || opts.expect?.test(text)) {
      bestClean = cleaned || bestClean;
      bestRaw = cleaned || text;
    }
  };

  // ---- Pass 1: seed inside gold/white ink with sampled colours ----
  const inkSeeds: { x: number; y: number; cols: ColortTriplet[] }[] = [];
  const xMax = Math.min(img.width - 4, 560);
  for (let y = 2; y < img.height - 2; y += 1) {
    for (let x = 4; x < xMax; x += 3) {
      const p = pixel(img, x, y);
      if (!p || !isOptionsInk(p[0], p[1], p[2])) continue;
      const cols = sampleNearbyColours(img, x, y);
      if (!cols.length) continue;
      inkSeeds.push({ x, y, cols });
      if (inkSeeds.length >= 48) break;
    }
    if (inkSeeds.length >= 48) break;
  }

  outerInk: for (const { name: fontName, font } of FONTS) {
    if (!font?.chars?.length) continue;
    for (const seed of inkSeeds) {
      for (const dy of [0, 1, 2, 3]) {
        attempts += 1;
        if (attempts > maxAttempts) break outerInk;
        const sy = seed.y + dy;
        if (sy >= img.height - 1) continue;
        try {
          const line = OCR.findReadLine(
            img,
            font,
            seed.cols,
            seed.x,
            sy,
            40,
            3,
          );
          consider(line?.text ?? "", {
            font: fontName,
            colour: "sampled",
            x: seed.x,
            y: sy,
          });
        } catch {
          // next
        }
        if (opts.expect?.test(bestClean) && letterScore(bestClean) >= 10) {
          break outerInk;
        }
      }
    }
  }

  // ---- Pass 2: fixed colour grid (fallback / no ink detected) ----
  if (letterScore(bestClean) < 10) {
    const baselines = findOptionsBaselines(img);
    const xs = [12, 24, 40, 56, 72, 96, 120, 150, 180, 220, 280, 340];

    outerFixed: for (const { name: fontName, font } of FONTS) {
      if (!font?.chars?.length) continue;
      for (const { name: colName, rgb } of OPTIONS_COLOURS) {
        for (const y of baselines) {
          for (const x of xs) {
            attempts += 1;
            if (attempts > maxAttempts + 80) break outerFixed;
            if (x >= img.width - 4 || y >= img.height - 2) continue;
            try {
              const line = OCR.findReadLine(img, font, [rgb], x, y, 56, 4);
              consider(line?.text ?? "", {
                font: fontName,
                colour: colName,
                x,
                y,
              });
            } catch {
              // next
            }
            if (opts.expect?.test(bestClean) && letterScore(bestClean) >= 10) {
              break outerFixed;
            }
          }
        }
      }
    }
  }

  // ---- Pass 3: multi-colour with chat12 ----
  const multi: ColortTriplet[] = [
    [255, 255, 0],
    [248, 213, 107],
    [230, 215, 152],
    [0, 255, 255],
    [255, 255, 255],
  ];
  const font = FONTS[0]?.font;
  if (font) {
    for (const y of findOptionsBaselines(img).slice(0, 5)) {
      for (const x of [24, 48, 80, 120, 180]) {
        try {
          const line = OCR.findReadLine(img, font, multi, x, y, 56, 4);
          consider(line?.text ?? "", {
            font: FONTS[0].name,
            colour: "multi",
            x,
            y,
          });
        } catch {
          // next
        }
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const raw = bestRaw || bestClean;
  const fuzzy = fuzzyCatalogueName(raw) || fuzzyCatalogueName(bestClean);
  return {
    name: fuzzy || bestClean,
    raw,
    hits: hits.slice(0, 40),
    inkCount,
  };
};

export const normalizeItemText = (raw: string): string =>
  String(raw ?? "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s*\(damaged\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Uint16Array(b.length + 1);
  const cur = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev.set(cur);
  }
  return prev[b.length];
};

/**
 * Map messy OCR (e.g. “Yurkalgokh stink grenod”) onto a catalogue artefact/material.
 */
export const fuzzyCatalogueName = (raw: string): string => {
  const cleaned = cleanOptionsText(raw);
  const norm = normalizeItemText(cleaned);
  if (norm.length < 4) return "";

  let bestName = "";
  let bestScore = Number.POSITIVE_INFINITY;
  let bestLen = 0;

  const consider = (name: string, hay: string): void => {
    const n = normalizeItemText(name);
    if (n.length < 4 || hay.length < 4) return;
    if (hay.includes(n) || (n.includes(hay) && hay.length >= 8)) {
      if (0 < bestScore || (0 === bestScore && n.length > bestLen)) {
        bestName = name;
        bestScore = 0;
        bestLen = n.length;
      }
      return;
    }
    const maxDist = Math.max(2, Math.min(6, Math.floor(n.length / 5)));
    if (Math.abs(n.length - hay.length) > maxDist + 2) return;
    const dist = editDistance(hay, n);
    if (dist > maxDist) return;
    if (dist < bestScore || (dist === bestScore && n.length > bestLen)) {
      bestName = name;
      bestScore = dist;
      bestLen = n.length;
    }
  };

  // Also try the leading words of the OCR (tesseract often appends junk).
  const words = norm.split(" ").filter(Boolean);
  const prefixes: string[] = [norm];
  for (let n = Math.min(words.length, 6); n >= 2; n -= 1) {
    prefixes.push(words.slice(0, n).join(" "));
  }

  for (const artefact of archaeologyData.artefacts) {
    for (const name of [artefact.name, artefact.damagedName]) {
      for (const hay of prefixes) consider(name, hay);
    }
  }
  for (const material of archaeologyData.materials) {
    for (const hay of prefixes) consider(material.name, hay);
  }
  return bestName ? cleanOptionsText(bestName) : "";
};
