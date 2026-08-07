import * as a1lib from "alt1/base";
import * as OCR from "alt1/ocr";
import { createWorker, type Worker } from "tesseract.js";
import { archaeologyData } from "./data";
import { matchArtefactText } from "./alt1";
import type { Artefact } from "./types";
import dialogOcrStripUrl from "./assets/dialog-ocr.data.png";
import dialogOcrMeta from "./assets/dialog-ocr.fontmeta.json" with { type: "json" };

type Area = { x: number; y: number; width: number; height: number };

const TEXT_COLOURS: OCR.ColortTriplet[] = [
  [2, 2, 2],
  [4, 4, 3],
  [5, 5, 4],
  [8, 7, 6],
  [9, 8, 7],
  [9, 8, 6],
  [16, 14, 12],
  [26, 10, 0],
  [16, 0, 0],
  [0, 0, 0],
];

/**
 * Dig-popup body text uses Jagex UI glyphs. We ship a custom Alt1 strip built
 * from lossless dialog screenshots (see scripts/build-dialog-font-strip.mjs).
 * Live Alt1 captures are softer than those crops, so tesseract backs the strip
 * when sprite OCR stalls. Noto Sans remains for ink-mask templates only.
 */
const DIALOGUE_FONT_FAMILY = '"Noto Sans", Arial, sans-serif';

const decodePngUrl = (url: string): Promise<ImageData> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        reject(new Error("Could not create canvas for dialog OCR font"));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = () => reject(new Error(`Failed to load dialog OCR font: ${url}`));
    image.src = url;
  });

let fonts: OCR.FontDefinition[] | null = null;
const dialogueFonts = (): OCR.FontDefinition[] => fonts ?? [];

let digTesseractPromise: Promise<Worker> | null = null;
const getDigTesseract = async (): Promise<Worker> => {
  if (!digTesseractPromise) {
    digTesseractPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 /'-():!,.",
        tessedit_pageseg_mode: "7" as never,
      });
      return worker;
    })().catch((error) => {
      digTesseractPromise = null;
      throw error;
    });
  }
  return digTesseractPromise;
};

const nearestScale = (src: ImageData, scale: number): ImageData => {
  const w = src.width * scale;
  const h = src.height * scale;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si =
        (Math.floor(y / scale) * src.width + Math.floor(x / scale)) * 4;
      const di = (y * w + x) * 4;
      data[di] = src.data[si];
      data[di + 1] = src.data[si + 1];
      data[di + 2] = src.data[si + 2];
      data[di + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
};

const imageDataToPngBlob = (img: ImageData): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("no canvas"));
      return;
    }
    ctx.putImageData(img, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("toBlob failed"));
      else resolve(blob);
    }, "image/png");
  });

const cropPaperTextBand = (
  screen: ImageData,
  paper: Area,
): ImageData | null => {
  const left = Math.max(0, paper.x + 70);
  const top = Math.max(0, paper.y + Math.floor(paper.height * 0.18));
  const width = Math.min(screen.width - left, paper.width - 90);
  const height = Math.min(
    screen.height - top,
    Math.max(22, Math.round(paper.height * 0.55)),
  );
  if (width < 80 || height < 14) return null;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * screen.width + left) * 4;
    data.set(screen.data.subarray(from, from + width * 4), y * width * 4);
  }
  return new ImageData(data, width, height);
};

/** Reject punctuation mush from soft live captures ("Yo '.. . .':!"). */
const isUsefulOcrReading = (text: string): boolean => {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 8) return false;
  const letters = (compact.match(/[A-Za-z]/g) ?? []).length;
  return letters >= 6 && letters / compact.length >= 0.45;
};

const hintsYouFind = (text: string): boolean => {
  const compact = text.replace(/\s+/g, "");
  return /youfind|find:/i.test(compact);
};

const isPaper = (data: Uint8ClampedArray, index: number): boolean => {
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  return (
    red >= 150 &&
    red <= 245 &&
    green >= 130 &&
    green <= 225 &&
    blue >= 90 &&
    blue <= 190 &&
    red >= green &&
    green > blue
  );
};

/**
 * Finds the broad parchment body of the "You find…" dialogue anywhere on
 * screen. Location is not assumed — players move the popup freely — so we
 * scan the full frame and pick the best wide parchment strip by shape.
 */
const findPaper = (screen: ImageData): Area | null => {
  const rows: { y: number; left: number; right: number }[] = [];
  const step = 3;

  for (let y = 0; y < screen.height; y += step) {
    let bestLeft = 0;
    let bestRight = 0;
    let runLeft = -1;
    let misses = 0;

    for (let x = 0; x < screen.width; x += step) {
      const paper = isPaper(screen.data, (y * screen.width + x) * 4);
      if (paper) {
        if (runLeft < 0) runLeft = x;
        misses = 0;
      } else if (runLeft >= 0 && ++misses > 3) {
        const right = x - misses * step;
        if (right - runLeft > bestRight - bestLeft) {
          bestLeft = runLeft;
          bestRight = right;
        }
        runLeft = -1;
        misses = 0;
      }
    }
    if (runLeft >= 0 && screen.width - runLeft > bestRight - bestLeft) {
      bestLeft = runLeft;
      bestRight = screen.width;
    }
    if (bestRight - bestLeft >= 260) rows.push({ y, left: bestLeft, right: bestRight });
  }

  if (!rows.length) return null;

  const groups: (typeof rows)[] = [];
  let group: typeof rows = [];
  for (const row of rows) {
    if (!group.length || row.y - group.at(-1)!.y <= step * 2) group.push(row);
    else {
      groups.push(group);
      group = [row];
    }
  }
  if (group.length) groups.push(group);

  let bestArea: Area | null = null;
  let bestScore = -1;

  for (const candidate of groups) {
    if (candidate.length * step < 45) continue;
    const sortedLeft = candidate.map((row) => row.left).sort((a, b) => a - b);
    const sortedRight = candidate.map((row) => row.right).sort((a, b) => a - b);
    const left = sortedLeft[Math.floor(sortedLeft.length / 2)];
    const right = sortedRight[Math.floor(sortedRight.length / 2)];
    const area: Area = {
      x: left,
      y: candidate[0].y,
      width: right - left,
      height: candidate.at(-1)!.y - candidate[0].y + step,
    };
    if (area.width < 320 || area.height < 48 || area.height > 180) continue;
    const aspect = area.width / area.height;
    // Find dialogue is a wide strip (~3–6×). Reject square-ish dirt patches.
    if (aspect < 2.4) continue;
    // Prefer wider, dialogue-height strips. No screen-position bias.
    const heightFit = 1 - Math.min(1, Math.abs(area.height - 90) / 90);
    const score = area.width * aspect * (0.55 + 0.45 * heightFit);
    if (score > bestScore) {
      bestScore = score;
      bestArea = area;
    }
  }

  return bestArea;
};

export interface ArtefactDialogueRead {
  artefact: Artefact;
  text: string;
}

interface TextMask {
  width: number;
  height: number;
  bits: Uint8Array;
}

const cropMask = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  dark: boolean,
): TextMask | null => {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  const source = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const marked = dark
        ? data[index] + data[index + 1] + data[index + 2] < 210
        : data[index + 3] >= 55;
      if (!marked) continue;
      source[y * width + x] = 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;

  const croppedWidth = right - left + 1;
  const croppedHeight = bottom - top + 1;
  const bits = new Uint8Array(croppedWidth * croppedHeight);
  for (let y = 0; y < croppedHeight; y += 1) {
    for (let x = 0; x < croppedWidth; x += 1) {
      bits[y * croppedWidth + x] = source[(top + y) * width + left + x];
    }
  }
  return { width: croppedWidth, height: croppedHeight, bits };
};

const maskAgreement = (actual: TextMask, template: TextMask): number => {
  let actualCovered = 0;
  let actualCount = 0;
  let templateCovered = 0;
  let templateCount = 0;

  // Compare after normalising both bounding boxes. A one-pixel neighbourhood
  // absorbs the small rasterisation difference between RuneScape and Chromium.
  const actualAt = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (
          px >= 0 &&
          py >= 0 &&
          px < actual.width &&
          py < actual.height &&
          actual.bits[py * actual.width + px]
        ) return true;
      }
    }
    return false;
  };
  const templateAt = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (
          px >= 0 &&
          py >= 0 &&
          px < template.width &&
          py < template.height &&
          template.bits[py * template.width + px]
        ) return true;
      }
    }
    return false;
  };

  for (let y = 0; y < actual.height; y += 1) {
    for (let x = 0; x < actual.width; x += 1) {
      if (!actual.bits[y * actual.width + x]) continue;
      actualCount += 1;
      const tx = Math.round((x * (template.width - 1)) / Math.max(1, actual.width - 1));
      const ty = Math.round((y * (template.height - 1)) / Math.max(1, actual.height - 1));
      if (templateAt(tx, ty)) actualCovered += 1;
    }
  }
  for (let y = 0; y < template.height; y += 1) {
    for (let x = 0; x < template.width; x += 1) {
      if (!template.bits[y * template.width + x]) continue;
      templateCount += 1;
      const ax = Math.round((x * (actual.width - 1)) / Math.max(1, template.width - 1));
      const ay = Math.round((y * (actual.height - 1)) / Math.max(1, template.height - 1));
      if (actualAt(ax, ay)) templateCovered += 1;
    }
  }
  if (!actualCount || !templateCount) return 0;
  return (actualCovered / actualCount + templateCovered / templateCount) / 2;
};

const TEMPLATE_FONTS = [
  `13px ${DIALOGUE_FONT_FAMILY}`,
  `12px ${DIALOGUE_FONT_FAMILY}`,
  "13px Arial", // fallback if Noto failed to load
];

interface NameTemplate {
  artefact: Artefact;
  text: string;
  masks: TextMask[];
}

// Rendering every artefact sentence in every font costs a few hundred canvas
// draws. The sentences never change, so pay for it once rather than on each
// poll while a dialogue is on screen.
let templates: NameTemplate[] | null = null;
let dialogueFontsWarmed = false;
let dialogueFontsWarmPromise: Promise<void> | null = null;

/** Load the custom dig-dialog OCR strip (+ Noto for mask templates). */
export const warmArtefactDialogueFonts = async (): Promise<void> => {
  if (dialogueFontsWarmed) return;
  if (dialogueFontsWarmPromise) return dialogueFontsWarmPromise;

  dialogueFontsWarmPromise = (async () => {
    if (typeof document !== "undefined" && document.fonts?.load) {
      try {
        await Promise.all([
          document.fonts.load(`12px ${DIALOGUE_FONT_FAMILY}`),
          document.fonts.load(`13px ${DIALOGUE_FONT_FAMILY}`),
          document.fonts.load(`400 12px "Noto Sans"`),
          document.fonts.load(`400 13px "Noto Sans"`),
        ]);
      } catch {
        // Templates fall back to Arial if the webfont fails.
      }
    }

    const strip = await decodePngUrl(dialogOcrStripUrl);
    const font = OCR.loadFontImage(
      strip,
      dialogOcrMeta as OCR.GenerateFontMeta,
    );
    // Dig text has ~1–2px gaps between letters and ~4px word spaces.
    font.spacewidth = 1;
    font.maxspaces = 6;
    fonts = [font];
    templates = null;
    dialogueFontsWarmed = true;
    // Warm tesseract in the background — live captures need it often.
    void getDigTesseract().catch(() => {
      /* optional */
    });
  })();

  try {
    await dialogueFontsWarmPromise;
  } catch (error) {
    dialogueFontsWarmPromise = null;
    throw error;
  }
};

const nameTemplates = (): NameTemplate[] => {
  if (templates) return templates;
  const canvas = document.createElement("canvas");
  canvas.width = 620;
  canvas.height = 26;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;

  templates = archaeologyData.artefacts.map((artefact) => {
    // Live UI uses a trailing "!" — older references used ".". Keep both masks.
    const sentences = [
      `You find: ${artefact.damagedName}!`,
      `You find: ${artefact.damagedName}.`,
    ];
    const masks: TextMask[] = [];
    for (const text of sentences) {
      for (const font of TEMPLATE_FONTS) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.font = font;
        context.textBaseline = "alphabetic";
        context.fillStyle = "black";
        context.fillText(text, 2, 16);
        const mask = cropMask(
          context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
          false,
        );
        if (mask) masks.push(mask);
      }
    }
    return {
      artefact,
      text: `You find: ${artefact.damagedName}!`,
      masks,
    };
  });
  return templates;
};

const knownTextMatches = (
  screen: ImageData,
  paper: Area,
): { artefact: Artefact; text: string; score: number }[] => {
  // Compare the black sentence only — skip the circular item icon on the left.
  const left = Math.max(0, paper.x + 70);
  const top = Math.max(0, paper.y + Math.floor(paper.height * 0.22));
  const width = Math.min(screen.width - left, paper.width - 90);
  const height = Math.min(
    screen.height - top,
    Math.max(22, Math.round(paper.height * 0.5)),
  );
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * screen.width + left) * 4;
    pixels.set(screen.data.subarray(from, from + width * 4), y * width * 4);
  }
  const actual = cropMask(pixels, width, height, true);
  if (!actual || actual.width < 80) return [];

  const matches: { artefact: Artefact; text: string; score: number }[] = [];
  for (const { artefact, text, masks } of nameTemplates()) {
    let best = 0;
    for (const template of masks) {
      // Shape alone makes sentences with similar letter distributions look
      // alike after normalisation. Text width is strong evidence too: in the
      // supplied lossless reference, the correct Pride of Padosan sentence is
      // about 10px wider than the closest wrong painting sentence.
      const widthAgreement =
        Math.min(actual.width, template.width) /
        Math.max(actual.width, template.width);
      const heightAgreement =
        Math.min(actual.height, template.height) /
        Math.max(actual.height, template.height);
      const score =
        maskAgreement(actual, template) * widthAgreement ** 3 * heightAgreement;
      best = Math.max(best, score);
    }
    matches.push({ artefact, text, score: best });
  }
  return matches.sort((a, b) => b.score - a.score);
};

export const debugArtefactDialogueOcr = (
  screen: ImageData,
): {
  paper: Area | null;
  readings: string[];
  knownMatches: { id: string; text: string; score: number }[];
} => {
  const paper = findPaper(screen);
  if (!paper) return { paper: null, readings: [], knownMatches: [] };

  // Text sits to the right of the circular item icon. Seed on dark ink in the
  // text band — fixed offsets miss tight crops and shifted popups.
  // findReadLine's w/h are a *search window* for the first glyph (not line length).
  const bandLeft = Math.max(0, paper.x + 40);
  const bandTop = Math.max(0, paper.y + Math.floor(paper.height * 0.2));
  const bandRight = Math.min(screen.width, paper.x + paper.width - 20);
  const bandBottom = Math.min(
    screen.height,
    paper.y + Math.floor(paper.height * 0.75),
  );
  const seeds: { x: number; y: number }[] = [];
  for (let y = bandTop; y < bandBottom; y += 2) {
    for (let x = bandLeft; x < Math.min(bandRight, bandLeft + 160); x += 3) {
      const i = (y * screen.width + x) * 4;
      const r = screen.data[i];
      const g = screen.data[i + 1];
      const b = screen.data[i + 2];
      if (r <= 40 && g <= 36 && b <= 32) {
        seeds.push({ x, y });
        if (seeds.length >= 24) break;
      }
    }
    if (seeds.length >= 24) break;
  }
  if (!seeds.length) {
    seeds.push(
      { x: paper.x + 72, y: paper.y + Math.floor(paper.height * 0.35) },
      { x: paper.x + 48, y: paper.y + Math.floor(paper.height * 0.35) },
    );
  }

  const readings: string[] = [];
  const seen = new Set<string>();
  for (const font of dialogueFonts()) {
    const searchW = Math.max(12, font.width + font.spacewidth);
    const searchH = Math.max(6, Math.min(14, font.height + 2));
    try {
      for (const seed of seeds) {
        const text = OCR.findReadLine(
          screen,
          font,
          TEXT_COLOURS,
          seed.x,
          seed.y,
          searchW,
          searchH,
        )?.text?.trim();
        if (!text || !isUsefulOcrReading(text) || seen.has(text)) continue;
        seen.add(text);
        readings.push(text);
        if (hintsYouFind(text)) break;
      }
    } catch {
      readings.push("<OCR error>");
    }
  }
  readings.sort((a, b) => b.replace(/\s+/g, "").length - a.replace(/\s+/g, "").length);
  return {
    paper,
    readings,
    knownMatches: knownTextMatches(screen, paper).slice(0, 5).map((match) => ({
      id: match.artefact.id,
      text: match.text,
      score: Math.round(match.score * 1000) / 1000,
    })),
  };
};

/**
 * Reads the text from a visible archaeology reward dialogue. It never clicks,
 * dismisses, or otherwise interacts with the game.
 *
 * `extraReadings` — e.g. tesseract lines already checked for "You find".
 * Parchment alone is not enough: OCR must look find-shaped before any accept
 * (including strong template matches), so other parchment UIs (pylon charge,
 * etc.) cannot count as dig finds.
 */
export const readArtefactDialogueFromImage = (
  screen: ImageData,
  extraReadings: string[] = [],
): ArtefactDialogueRead | null => {
  const debug = debugArtefactDialogueOcr(screen);
  const readings = [...extraReadings, ...debug.readings];
  for (const text of readings) {
    if (!hintsYouFind(text)) continue;
    const artefact = matchArtefactText(text, archaeologyData.artefacts);
    if (artefact) return { artefact, text };
  }

  // No find-shaped text → ignore parchment (templates would FP on other UIs).
  if (!readings.some((text) => hintsYouFind(text))) return null;

  const first = debug.knownMatches[0];
  const second = debug.knownMatches[1];
  if (!first) return null;

  const margin = second ? first.score - second.score : 1;
  // Template accepts still need a clear winner once OCR saw "You find".
  const confident =
    (first.score >= 0.85 && margin >= 0.02) ||
    (first.score >= 0.7 && margin >= 0.03) ||
    (first.score >= 0.55 && margin >= 0.05);

  let pick = first;
  // Near-tie: prefer the longer damaged name (crossbow beats dagger, etc.).
  if (
    second &&
    margin < 0.03 &&
    first.score >= 0.7 &&
    second.score >= 0.7
  ) {
    const a = archaeologyData.artefacts.find((item) => item.id === first.id);
    const b = archaeologyData.artefacts.find((item) => item.id === second.id);
    if (a && b && b.damagedName.length > a.damagedName.length + 4) {
      pick = second;
    }
  }

  const nearTie =
    pick.score >= 0.78 &&
    margin < 0.03;

  if (
    !confident &&
    !nearTie &&
    !(pick !== first && pick.score >= 0.7 && margin < 0.03)
  ) {
    return null;
  }

  const artefact = archaeologyData.artefacts.find((item) => item.id === pick.id);
  if (!artefact) return null;
  return { artefact, text: pick.text };
};

/**
 * Tesseract on the parchment text band — robust on soft live Alt1 captures.
 * Returns the first find-shaped line (and an artefact match when OCR names it).
 */
const readDigPopupTesseract = async (
  screen: ImageData,
  paper: Area,
): Promise<{ text: string; artefact: Artefact | null } | null> => {
  const band = cropPaperTextBand(screen, paper);
  if (!band) return null;
  try {
    const worker = await getDigTesseract();
    for (const scale of [3, 2, 4]) {
      const blob = await imageDataToPngBlob(nearestScale(band, scale));
      const {
        data: { text },
      } = await worker.recognize(blob);
      const raw = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!raw || !hintsYouFind(raw)) continue;
      return {
        text: raw,
        artefact: matchArtefactText(raw, archaeologyData.artefacts),
      };
    }
  } catch {
    // tesseract unavailable
  }
  return null;
};

const captureDialogueScreen = (): ImageData | null => {
  // Prefer plain capture — captureHoldFullRs fights the chatbox reader when we
  // alternate mat/artefact ticks, which is the usual failure mode now.
  try {
    const w = window.alt1?.rsWidth ?? 0;
    const h = window.alt1?.rsHeight ?? 0;
    if (w > 0 && h > 0) {
      const screen = a1lib.capture(0, 0, w, h);
      if (screen?.data) return screen;
    }
  } catch {
    // fall through
  }
  try {
    const hold = a1lib.captureHoldFullRs?.();
    if (hold && typeof hold.toData === "function") {
      const full = hold.toData();
      if (full?.data) return full;
    }
  } catch {
    // ignore
  }
  return null;
};

export type ArtefactDialogueProbe = {
  capture: boolean;
  paper: Area | null;
  /** True when OCR saw find-shaped text ("You find" / "find:"). */
  findShaped: boolean;
  readings: string[];
  topMatch: { id: string; text: string; score: number } | null;
  secondMatch: { id: string; text: string; score: number } | null;
  hit: ArtefactDialogueRead | null;
};

/** One-shot diagnostic for why a visible find popup is/isn't accepted. */
export const probeArtefactDialogue = async (): Promise<ArtefactDialogueProbe> => {
  const screen = captureDialogueScreen();
  if (!screen) {
    return {
      capture: false,
      paper: null,
      findShaped: false,
      readings: [],
      topMatch: null,
      secondMatch: null,
      hit: null,
    };
  }
  const debug = debugArtefactDialogueOcr(screen);
  const extraReadings: string[] = [];
  let hit = readArtefactDialogueFromImage(screen);

  // Soft captures often miss "You find" on the glyph reader — try tesseract
  // before giving up. Other parchment UIs (pylon charge, etc.) never pass.
  if (!hit && debug.paper) {
    const tess = await readDigPopupTesseract(screen, debug.paper);
    if (tess) {
      if (!debug.readings.includes(tess.text)) {
        debug.readings.unshift(tess.text);
      }
      extraReadings.push(tess.text);
      if (tess.artefact) {
        hit = { artefact: tess.artefact, text: tess.text };
      } else {
        // Find-shaped OCR without a name match — allow templates now.
        hit = readArtefactDialogueFromImage(screen, extraReadings);
      }
    }
  }

  const findShaped =
    Boolean(hit) || debug.readings.some((text) => hintsYouFind(text));

  return {
    capture: true,
    paper: debug.paper,
    findShaped,
    readings: debug.readings,
    // Only surface template near-misses when the text looks like a dig find.
    topMatch: findShaped ? (debug.knownMatches[0] ?? null) : null,
    secondMatch: findShaped ? (debug.knownMatches[1] ?? null) : null,
    hit,
  };
};

export const readArtefactDialogue = async (): Promise<ArtefactDialogueRead | null> => {
  const probe = await probeArtefactDialogue();
  return probe.hit;
};
