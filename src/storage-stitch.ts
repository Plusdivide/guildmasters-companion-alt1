/**
 * Build a tall still of storage by gluing settled viewport crops with pixel
 * overlap alignment. Matching is a separate step on the finished composite.
 */
import * as a1lib from "alt1/base";

export type ScanArea = { x: number; y: number; width: number; height: number };

export type StitchStatus =
  | { ok: true; appendedPx: number; strips: number }
  | { ok: false; reason: "no-overlap" | "capture-failed" | "too-similar" };

export interface StorageStitch {
  composite: ImageData | null;
  strips: number;
  lastSignature: number | null;
  area: ScanArea;
}

const MAX_COMPOSITE_HEIGHT = 8000;
/** Template height from the top of a new crop used to find overlap. */
const TEMPLATE_FRAC = 0.35;
const TEMPLATE_MIN = 24;
const TEMPLATE_MAX = 120;
/** Accept a join only when mean absolute RGB error stays under this (0–255). */
const MAX_MEAN_ABS_ERR = 28;
/** Subsample step for correlation (speed). */
const STEP = 2;

export const createStitch = (area: ScanArea): StorageStitch => ({
  composite: null,
  strips: 0,
  lastSignature: null,
  area: { ...area },
});

export const imageDataToPngUrl = (image: ImageData): string => {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
};

const cloneImage = (image: ImageData): ImageData =>
  new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);

const captureArea = (area: ScanArea): ImageData | null => {
  try {
    return a1lib.capture(area.x, area.y, area.width, area.height);
  } catch {
    return null;
  }
};

/** Sparse fingerprint — same idea as paneSignature, local to a crop. */
export const cropSignature = (image: ImageData): number => {
  let hash = 2166136261;
  for (let index = 0; index < image.data.length; index += 4 * 17) {
    hash = Math.imul(hash ^ image.data[index], 16777619);
  }
  return hash >>> 0;
};

const meanAbsErr = (
  hay: ImageData,
  hayX: number,
  hayY: number,
  needle: ImageData,
  needleY0: number,
  needleH: number,
): number => {
  let sum = 0;
  let n = 0;
  const w = Math.min(hay.width, needle.width);
  for (let y = 0; y < needleH; y += STEP) {
    const hy = hayY + y;
    const ny = needleY0 + y;
    if (hy < 0 || hy >= hay.height || ny < 0 || ny >= needle.height) continue;
    const hRow = hy * hay.width * 4;
    const nRow = ny * needle.width * 4;
    for (let x = 0; x < w; x += STEP) {
      const hi = hRow + (hayX + x) * 4;
      const ni = nRow + x * 4;
      sum +=
        Math.abs(hay.data[hi] - needle.data[ni]) +
        Math.abs(hay.data[hi + 1] - needle.data[ni + 1]) +
        Math.abs(hay.data[hi + 2] - needle.data[ni + 2]);
      n += 1;
    }
  }
  return n ? sum / (n * 3) : 999;
};

/**
 * Find where the top of `crop` best matches inside the bottom of `composite`.
 * Returns the y in composite where crop's top should sit (overlap start).
 */
const findOverlapY = (
  composite: ImageData,
  crop: ImageData,
): { y: number; err: number } | null => {
  const templateH = Math.max(
    TEMPLATE_MIN,
    Math.min(TEMPLATE_MAX, Math.floor(crop.height * TEMPLATE_FRAC)),
  );
  if (composite.height < templateH || crop.height < templateH) return null;

  // Search the bottom window of the composite (about one viewport).
  const searchTop = Math.max(0, composite.height - crop.height);
  const searchBottom = composite.height - templateH;
  if (searchBottom < searchTop) return null;

  let bestY = searchTop;
  let bestErr = Infinity;
  for (let y = searchTop; y <= searchBottom; y += 1) {
    const err = meanAbsErr(composite, 0, y, crop, 0, templateH);
    if (err < bestErr) {
      bestErr = err;
      bestY = y;
    }
  }
  if (bestErr > MAX_MEAN_ABS_ERR) return null;
  return { y: bestY, err: bestErr };
};

const appendRows = (
  composite: ImageData,
  crop: ImageData,
  cropY0: number,
): ImageData => {
  const addH = crop.height - cropY0;
  if (addH <= 0) return composite;
  const width = Math.min(composite.width, crop.width);
  const height = Math.min(MAX_COMPOSITE_HEIGHT, composite.height + addH);
  const out = new ImageData(width, height);
  out.data.set(
    composite.data.subarray(0, width * composite.height * 4),
  );
  for (let y = 0; y < addH && composite.height + y < height; y += 1) {
    const src = ((cropY0 + y) * crop.width) * 4;
    const dst = ((composite.height + y) * width) * 4;
    out.data.set(crop.data.subarray(src, src + width * 4), dst);
  }
  return out;
};

/**
 * Capture the current storage viewport and append newly revealed rows.
 * First call seeds the composite; later calls pixel-align on overlap.
 */
export const appendSettledCrop = (stitch: StorageStitch): StitchStatus => {
  const crop = captureArea(stitch.area);
  if (!crop) return { ok: false, reason: "capture-failed" };

  const signature = cropSignature(crop);
  if (signature === stitch.lastSignature) {
    return { ok: false, reason: "too-similar" };
  }

  if (!stitch.composite) {
    stitch.composite = cloneImage(crop);
    stitch.strips = 1;
    stitch.lastSignature = signature;
    return { ok: true, appendedPx: crop.height, strips: 1 };
  }

  // Same dimensions preferred; width mismatch crops to the narrower.
  if (crop.width !== stitch.composite.width) {
    // Still try — appendRows uses min width.
  }

  const overlap = findOverlapY(stitch.composite, crop);
  if (!overlap) {
    return { ok: false, reason: "no-overlap" };
  }

  const cropY0 = stitch.composite.height - overlap.y;
  if (cropY0 <= 2) {
    // Almost fully overlapping — treat as same view.
    stitch.lastSignature = signature;
    return { ok: false, reason: "too-similar" };
  }
  if (cropY0 >= crop.height - 2) {
    return { ok: false, reason: "no-overlap" };
  }

  const before = stitch.composite.height;
  stitch.composite = appendRows(stitch.composite, crop, cropY0);
  stitch.strips += 1;
  stitch.lastSignature = signature;
  return {
    ok: true,
    appendedPx: stitch.composite.height - before,
    strips: stitch.strips,
  };
};

/** One-shot capture into an empty stitch (first strip / Scan-once style seed). */
export const seedFromCapture = (stitch: StorageStitch): StitchStatus => {
  stitch.composite = null;
  stitch.strips = 0;
  stitch.lastSignature = null;
  return appendSettledCrop(stitch);
};
