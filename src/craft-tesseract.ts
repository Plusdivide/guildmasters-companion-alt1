/**
 * Tesseract reader for the craft-popup artefact name band (browser).
 * Offline recipe: crop name band → ×2/×3 upscale → whitelist OCR → catalogue match.
 */
import { createWorker, type Worker } from "tesseract.js";
import { archaeologyData } from "./data";
import { matchArtefactText } from "./alt1";
import {
  cropImage,
  findCraftNameBand,
  nearestScale,
  readCraftProgress,
} from "./craft-detect";
import type { Artefact } from "./types";

let workerPromise: Promise<Worker> | null = null;

const getWorker = async (): Promise<Worker> => {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 /'-",
        // PSM.SINGLE_LINE — same string as options-tesseract (typed narrowly upstream).
        tessedit_pageseg_mode: "7" as never,
      });
      return worker;
    })();
  }
  return workerPromise;
};

const imageDataToPngBlob = (img: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("no canvas"));
      return;
    }
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
      0,
      0,
    );
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("toBlob failed"));
      else resolve(blob);
    }, "image/png");
  });

const normalize = (text: string): string =>
  text
    .replace(/\(damaged\)/gi, "")
    .replace(/[’']/g, "'")
    .replace(/[^a-zA-Z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Read artefact name from a craft / restoration popup capture. */
export const readCraftArtefactTesseract = async (
  image: ImageData,
): Promise<Artefact | null> => {
  const progress = readCraftProgress(image);
  const band = findCraftNameBand(image, progress?.bar ?? null);
  if (!band) return null;

  const crop = cropImage(image, band);
  const worker = await getWorker();

  for (const scale of [2, 3, 4]) {
    try {
      const scaled = nearestScale(crop, scale);
      const blob = await imageDataToPngBlob(scaled);
      const {
        data: { text },
      } = await worker.recognize(blob);
      const raw = normalize(String(text ?? ""));
      if (raw.length < 4) continue;
      if (/^(restoration|cancel|done|materials|requirements)$/i.test(raw)) {
        continue;
      }
      const hit = matchArtefactText(raw, archaeologyData.artefacts);
      if (hit) return hit;
    } catch {
      // try next scale
    }
  }
  return null;
};
