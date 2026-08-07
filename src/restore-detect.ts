/**
 * Pure RESTORATION-window detection (no Alt1, no DOM).
 *
 * Same approach as bank/workbench title locate in scanner.ts:
 * gold glyph signature from title-restoration.png, tolerances 12 → 45 → 90.
 *
 * No button / OCR / lobby special cases — those caused false locks.
 */

export type ImageLike = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

export type Area = { x: number; y: number; width: number; height: number };

export type TitleSignature = {
  width: number;
  height: number;
  points: Int16Array;
};

export type RestoreLocateResult = {
  title: Area;
  via: "signature";
};

/** Identical to scanner.ts bank/workbench title gold. */
const TITLE_GLYPH: [number, number, number] = [240, 190, 121];
export const TITLE_GLYPH_TOLERANCE = 12;
export const TITLE_MIN_HIT_RATIO = 0.9;
export const TITLE_MAX_LIT_RATIO = 2;
export const TITLE_ALIGN_RADIUS = 3;

export const isGlyphPixel = (
  data: ImageLike["data"],
  index: number,
  tolerance = TITLE_GLYPH_TOLERANCE,
): boolean =>
  Math.abs(data[index] - TITLE_GLYPH[0]) +
    Math.abs(data[index + 1] - TITLE_GLYPH[1]) +
    Math.abs(data[index + 2] - TITLE_GLYPH[2]) <=
  tolerance;

export const isGlyphPixelStrict = isGlyphPixel;

export const signatureFrom = (image: ImageLike): TitleSignature | null => {
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
  return { width: maxX - minX + 1, height: maxY - minY + 1, points };
};

/**
 * Bank-style title locate (copy of scanner findTitle for one signature).
 */
export const findRestorationTitle = (
  image: ImageLike,
  signature: TitleSignature,
  tolerance: number,
  _step = 1,
): Area | null => {
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

  const bands: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    count: number;
  }[] = [];
  for (const row of rows) {
    const band = bands.at(-1);
    if (band && row.y - band.maxY <= 3) {
      band.maxY = row.y;
      band.minX = Math.min(band.minX, row.minX);
      band.maxX = Math.max(band.maxX, row.maxX);
      band.count += row.count;
    } else {
      bands.push({
        minX: row.minX,
        maxX: row.maxX,
        minY: row.y,
        maxY: row.y,
        count: row.count,
      });
    }
  }

  const matches = (originX: number, originY: number): boolean => {
    if (originX < 0 || originY < 0) return false;
    if (originX + signature.width > image.width) return false;
    if (originY + signature.height > image.height) return false;
    const { points } = signature;
    const total = points.length / 2;
    const allowedMisses = Math.floor(total * (1 - TITLE_MIN_HIT_RATIO));
    let missed = 0;
    for (let n = 0; n < points.length; n += 2) {
      if (glyph[(originY + points[n + 1]) * image.width + originX + points[n]]) {
        continue;
      }
      if (++missed > allowedMisses) return false;
    }

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
    if (band.count < (signature.points.length / 2) * TITLE_MIN_HIT_RATIO) {
      continue;
    }
    if (bandWidth + TITLE_ALIGN_RADIUS < signature.width) continue;

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
        if (!matches(x, y)) continue;
        return {
          x,
          y,
          width: signature.width,
          height: signature.height,
        };
      }
    }
  }
  return null;
};

/** Kept for craft progress helpers / overlays — not used to open restore mode. */
export const findRestoreButton = (_image: ImageLike): Area | null => null;

export const hasCraftProgressBar = (
  _image: ImageLike,
  _title: Area,
): boolean => false;

/**
 * Locate RESTORATION — title signature only (bank-style).
 */
export const locateRestorationInImage = (
  image: ImageLike,
  signature: TitleSignature | null,
): RestoreLocateResult | null => {
  if (!signature) return null;
  for (const tolerance of [TITLE_GLYPH_TOLERANCE, 45, 90]) {
    const title = findRestorationTitle(image, signature, tolerance);
    if (title) return { title, via: "signature" };
  }
  return null;
};
