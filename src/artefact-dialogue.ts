import * as a1lib from "alt1/base";
import * as OCR from "alt1/ocr";
import { archaeologyData } from "./data";
import { matchArtefactText } from "./alt1";
import type { Artefact } from "./types";

type Area = { x: number; y: number; width: number; height: number };

const TEXT_COLOURS: OCR.ColortTriplet[] = [
  [9, 8, 7],
  [9, 8, 6],
  [16, 14, 12],
  [0, 0, 0],
];

/**
 * The reward dialogue uses ordinary anti-aliased interface text, not the pixel
 * font used by chat. Alt1 does not ship that font, so build its OCR definition
 * once from the browser's matching Arial glyphs.
 */
const makeFont = (size: number): OCR.FontDefinition => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'():,.-!?/";
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.font = `${size}px Arial`;

  const widths = [...chars].map((char) =>
    Math.max(1, Math.ceil(context.measureText(char).width)),
  );
  canvas.width = widths.reduce((sum, width) => sum + width + 2, 0);
  canvas.height = size + 7;

  const draw = canvas.getContext("2d", { willReadFrequently: true })!;
  draw.fillStyle = "black";
  draw.fillRect(0, 0, canvas.width, canvas.height);
  draw.font = `${size}px Arial`;
  draw.textBaseline = "alphabetic";
  draw.fillStyle = "white";

  const baseline = size + 1;
  let x = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const width = widths[index];
    draw.fillText(chars[index], x, baseline);
    x += width + 2;
  }

  // OCR's generator needs the white-on-black raster converted back into alpha.
  // Mark character widths only after that conversion, otherwise the red marker
  // itself is interpreted as part of a glyph.
  const unblended = OCR.unblendBlackBackground(
    draw.getImageData(0, 0, canvas.width, canvas.height),
    255,
    255,
    255,
  );
  x = 0;
  for (const width of widths) {
    for (let marker = x; marker < x + width; marker += 1) {
      const index = ((unblended.height - 1) * unblended.width + marker) * 4;
      unblended.data[index] = 255;
      unblended.data[index + 1] = 0;
      unblended.data[index + 2] = 0;
      unblended.data[index + 3] = 255;
    }
    x += width + 2;
  }
  return OCR.generateFont(unblended, chars, ".,'!:;", {}, baseline, 4, 0.3, false);
};

let fonts: OCR.FontDefinition[] | null = null;
const dialogueFonts = (): OCR.FontDefinition[] => {
  fonts ??= [makeFont(13), makeFont(12)];
  return fonts;
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
 * Finds the broad parchment body of the "You find…" dialogue. A reward popup
 * has a long run of parchment on many adjacent rows; normal game scenery does
 * not need to be classified precisely because OCR still has to read an artefact
 * name before anything is added.
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
  let best: typeof rows = [];
  let group: typeof rows = [];
  for (const row of rows) {
    if (!group.length || row.y - group.at(-1)!.y <= step * 2) group.push(row);
    else {
      if (group.length > best.length) best = group;
      group = [row];
    }
  }
  if (group.length > best.length) best = group;
  if (best.length * step < 45) return null;

  const sortedLeft = best.map((row) => row.left).sort((a, b) => a - b);
  const sortedRight = best.map((row) => row.right).sort((a, b) => a - b);
  const left = sortedLeft[Math.floor(sortedLeft.length / 2)];
  const right = sortedRight[Math.floor(sortedRight.length / 2)];
  const area = {
    x: left,
    y: best[0].y,
    width: right - left,
    height: best.at(-1)!.y - best[0].y + step,
  };
  if (area.width < 350 || area.height < 55 || area.height > 130) return null;
  return area;
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

const TEMPLATE_FONTS = ["13px Arial", "13px Tahoma", "12px Arial"];

interface NameTemplate {
  artefact: Artefact;
  text: string;
  masks: TextMask[];
}

// Rendering every artefact sentence in every font costs a few hundred canvas
// draws. The sentences never change, so pay for it once rather than on each
// poll while a dialogue is on screen.
let templates: NameTemplate[] | null = null;
const nameTemplates = (): NameTemplate[] => {
  if (templates) return templates;
  const canvas = document.createElement("canvas");
  canvas.width = 620;
  canvas.height = 26;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;

  templates = archaeologyData.artefacts.map((artefact) => {
    const text = `You find: ${artefact.damagedName}.`;
    const masks: TextMask[] = [];
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
    return { artefact, text, masks };
  });
  return templates;
};

const knownTextMatches = (
  screen: ImageData,
  paper: Area,
): { artefact: Artefact; text: string; score: number }[] => {
  const left = Math.max(0, paper.x + 12);
  const top = Math.max(0, paper.y + 10);
  const width = Math.min(screen.width - left, paper.width - 18);
  const height = Math.min(screen.height - top, Math.round(paper.height * 0.55));
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
  const x = Math.max(0, paper.x + 12);
  const y = Math.max(0, paper.y + 8);
  const width = Math.min(screen.width - x, paper.width - 18);
  const height = Math.max(20, paper.height - 16);
  const readings: string[] = [];
  for (const font of dialogueFonts()) {
    try {
      const text = OCR.findReadLine(
        screen,
        font,
        TEXT_COLOURS,
        x,
        y,
        width,
        height,
      )?.text?.trim();
      if (text) readings.push(text);
    } catch {
      readings.push("<OCR error>");
    }
  }
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
 */
export const readArtefactDialogueFromImage = (
  screen: ImageData,
): ArtefactDialogueRead | null => {
  const debug = debugArtefactDialogueOcr(screen);
  const { readings } = debug;
  for (const text of readings) {
    if (!/you\s+find/i.test(text)) continue;
    const artefact = matchArtefactText(text, archaeologyData.artefacts);
    if (artefact) return { artefact, text };
  }
  const first = debug.knownMatches[0];
  const second = debug.knownMatches[1];
  if (first && first.score >= 0.52 && (!second || first.score - second.score >= 0.015)) {
    const artefact = archaeologyData.artefacts.find((item) => item.id === first.id);
    if (artefact) return { artefact, text: first.text };
  }
  return null;
};

export const readArtefactDialogue = (): ArtefactDialogueRead | null => {
  const capture = a1lib.captureHoldFullRs();
  return capture ? readArtefactDialogueFromImage(capture.toData()) : null;
};
