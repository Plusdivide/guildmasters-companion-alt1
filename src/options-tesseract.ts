/**
 * Tesseract-backed options-strip reader for the live Alt1 app (browser canvas).
 */
import { createWorker, type Worker } from "tesseract.js";
import {
  cleanOptionsText,
  countOptionsInk,
  fuzzyCatalogueName,
  letterScore,
  type OptionsReadResult,
} from "./options-ocr";

let workerPromise: Promise<Worker> | null = null;

const getWorker = async (): Promise<Worker> => {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 /'-",
        tessedit_pageseg_mode: "7",
      });
      return worker;
    })();
  }
  return workerPromise;
};

/** Start loading the OCR worker early (teach start). */
export const warmOptionsTesseract = (): void => {
  void getWorker().catch(() => {
    workerPromise = null;
  });
};

const nearest = (src: ImageData, scale: number): ImageData => {
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

/**
 * Read an options strip with tesseract, then fuzzy-map onto the catalogue.
 * Recipe proven offline: raw ×3 upscale → tesseract → fuzzyCatalogueName.
 * Also tries ×2 / raw for native 1:1 Alt1 captures.
 */
export const readOptionsStripTesseract = async (
  img: ImageData,
): Promise<OptionsReadResult> => {
  const inkCount = countOptionsInk(img);
  const worker = await getWorker();
  const variants: { name: string; image: ImageData }[] = [
    { name: "raw-x3", image: nearest(img, 3) },
    { name: "raw-x2", image: nearest(img, 2) },
    { name: "raw-x4", image: nearest(img, 4) },
    { name: "raw", image: img },
  ];

  let bestRaw = "";
  let bestName = "";
  let bestScore = -1;
  const hits: OptionsReadResult["hits"] = [];

  for (const variant of variants) {
    try {
      const blob = await imageDataToPngBlob(variant.image);
      const {
        data: { text, confidence },
      } = await worker.recognize(blob);
      const raw = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!raw) continue;
      const cleaned = cleanOptionsText(raw);
      const matched = fuzzyCatalogueName(cleaned) || fuzzyCatalogueName(raw);
      const score =
        (matched ? 2000 : 0) +
        confidence +
        letterScore(cleaned) * 2 +
        letterScore(matched) * 3;
      hits.push({
        raw,
        cleaned: matched || cleaned,
        font: "tesseract",
        colour: variant.name,
        x: 0,
        y: 0,
        score,
      });
      if (score > bestScore) {
        bestScore = score;
        bestRaw = cleaned || raw;
        bestName = matched || cleaned;
      }
      if (matched && letterScore(matched) >= 10) break;
    } catch {
      // try next variant
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return {
    name: bestName,
    raw: bestRaw || bestName,
    hits: hits.slice(0, 20),
    inkCount,
  };
};
