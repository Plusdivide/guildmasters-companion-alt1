/**
 * Pure craft-popup detection (no Alt1).
 * Locates the green N/M progress bar and the artefact name band under RESTORATION.
 */

export type ImageLike = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

export type Area = { x: number; y: number; width: number; height: number };

export type CraftProgress = {
  n: number;
  m: number;
  raw: string;
  bar: Area;
};

export type CraftNameBand = Area;

const isProgressGreen = (
  data: ImageLike["data"],
  index: number,
): boolean => {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  return g > 100 && g > r + 15 && g > b + 20 && r < 190 && b < 160;
};

const isWhiteInk = (
  data: ImageLike["data"],
  index: number,
  threshold = 200,
): boolean =>
  data[index] >= threshold &&
  data[index + 1] >= threshold &&
  data[index + 2] >= threshold;

/** Wide filled green craft progress bar (not the thin title outline). */
export const findCraftProgressBar = (image: ImageLike): Area | null => {
  const rows: { y: number; left: number; right: number }[] = [];
  const y0 = Math.floor(image.height * 0.35);
  const y1 = Math.floor(image.height * 0.85);
  for (let y = y0; y < y1; y += 1) {
    let bestL = 0;
    let bestR = 0;
    let run = -1;
    let misses = 0;
    for (let x = 0; x < image.width; x += 1) {
      if (isProgressGreen(image.data, (y * image.width + x) * 4)) {
        if (run < 0) run = x;
        misses = 0;
      } else if (run >= 0 && ++misses > 4) {
        const right = x - misses;
        if (right - run > bestR - bestL) {
          bestL = run;
          bestR = right;
        }
        run = -1;
        misses = 0;
      }
    }
    if (run >= 0 && image.width - run > bestR - bestL) {
      bestL = run;
      bestR = image.width;
    }
    const w = bestR - bestL;
    if (w >= 180 && w <= Math.floor(image.width * 0.95)) {
      rows.push({ y, left: bestL, right: bestR });
    }
  }
  if (rows.length < 3) return null;

  let best = rows.slice(0, 1);
  let cur = rows.slice(0, 1);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].y - cur.at(-1)!.y <= 2) cur.push(rows[i]);
    else {
      if (cur.length > best.length) best = cur;
      cur = [rows[i]];
    }
  }
  if (cur.length > best.length) best = cur;

  const height = best.at(-1)!.y - best[0].y + 1;
  if (height < 6 || height > 28) return null;

  const left = best.map((r) => r.left).sort((a, b) => a - b)[
    Math.floor(best.length / 2)
  ];
  const right = best.map((r) => r.right).sort((a, b) => a - b)[
    Math.floor(best.length / 2)
  ];
  return {
    x: left,
    y: best[0].y,
    width: right - left,
    height,
  };
};

type InkGroup = { left: number; right: number; ink: number };

const inkGroupsInBar = (
  image: ImageLike,
  bar: Area,
): InkGroup[] => {
  const padX = Math.floor(bar.width * 0.28);
  const x0 = bar.x + padX;
  const x1 = bar.x + bar.width - padX;
  // Expand a couple px — the green fill band can clip glyph tops/bottoms.
  const y0 = Math.max(0, bar.y - 2);
  const y1 = Math.min(image.height, bar.y + bar.height + 2);
  const width = x1 - x0;
  if (width < 20) return [];

  const cols = new Array<number>(width).fill(0);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!isWhiteInk(image.data, (y * image.width + x) * 4, 190)) continue;
      cols[x - x0] += 1;
    }
  }

  const groups: InkGroup[] = [];
  let run = -1;
  let ink = 0;
  for (let x = 0; x < width; x += 1) {
    if (cols[x] >= 1) {
      if (run < 0) {
        run = x;
        ink = 0;
      }
      ink += cols[x];
    } else if (run >= 0) {
      groups.push({ left: x0 + run, right: x0 + x - 1, ink });
      run = -1;
    }
  }
  if (run >= 0) groups.push({ left: x0 + run, right: x0 + width - 1, ink });
  return groups.filter((g) => g.ink >= 2);
};

const classifySlashIndex = (groups: InkGroup[]): number => {
  if (groups.length < 3) return -1;
  // Prefer a mid-width, mid-position group (the '/' stroke).
  let best = -1;
  let bestScore = -1;
  const mid = (groups.length - 1) / 2;
  for (let i = 1; i < groups.length - 1; i += 1) {
    const w = groups[i].right - groups[i].left + 1;
    const centerBias = 1 / (1 + Math.abs(i - mid));
    const widthScore = w >= 1 && w <= 5 ? 3 : w <= 8 ? 1 : 0;
    const score = widthScore * 10 + centerBias * 5 + (groups[i].ink < 40 ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
};

/**
 * Read N/M from white ink glyphs inside the green progress bar.
 * Works without OCR fonts — uses ink-group structure + per-glyph digit shapes.
 */
export const readCraftProgress = (
  image: ImageLike,
  barHint?: Area | null,
): CraftProgress | null => {
  const bar = barHint ?? findCraftProgressBar(image);
  if (!bar) return null;

  const groups = inkGroupsInBar(image, bar);
  if (groups.length < 3) return null;

  const slashAt = classifySlashIndex(groups);
  if (slashAt < 0) return null;

  const leftGroups = groups.slice(0, slashAt);
  const rightGroups = groups.slice(slashAt + 1);
  if (!leftGroups.length || !rightGroups.length) return null;

  const n = groupsToInt(image, bar, leftGroups);
  const m = groupsToInt(image, bar, rightGroups);
  if (n === null || m === null) return null;
  if (m < 1 || m > 99 || n < 0 || n > m) return null;

  return { n, m, raw: `${n}/${m}`, bar };
};

/** Classify a single white-ink glyph as digit 0–9 (shape features). */
const classifyDigitGlyph = (
  image: ImageLike,
  left: number,
  right: number,
  top: number,
  bottom: number,
): number | null => {
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < 1 || h < 4) return null;

  const gridW = 5;
  const gridH = 7;
  const cells = new Array<number>(gridW * gridH).fill(0);
  let ink = 0;
  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      const x0 = left + Math.floor((gx * w) / gridW);
      const x1 = left + Math.floor(((gx + 1) * w) / gridW);
      const y0 = top + Math.floor((gy * h) / gridH);
      const y1 = top + Math.floor(((gy + 1) * h) / gridH);
      let hit = 0;
      let total = 0;
      for (let y = y0; y < Math.max(y0 + 1, y1); y += 1) {
        for (let x = x0; x < Math.max(x0 + 1, x1); x += 1) {
          total += 1;
          if (isWhiteInk(image.data, (y * image.width + x) * 4, 195)) {
            hit += 1;
            ink += 1;
          }
        }
      }
      cells[gy * gridW + gx] = total && hit / total >= 0.25 ? 1 : 0;
    }
  }

  // Tall thin stroke → 1
  if (w <= 3 && ink >= 4) return 1;

  const row = (y: number) => {
    let s = 0;
    for (let x = 0; x < gridW; x += 1) s += cells[y * gridW + x];
    return s;
  };
  const col = (x: number) => {
    let s = 0;
    for (let y = 0; y < gridH; y += 1) s += cells[y * gridW + x];
    return s;
  };
  const topR = row(0) + row(1);
  const midR = row(2) + row(3) + row(4);
  const botR = row(5) + row(6);
  const leftC = col(0) + col(1);
  const midC = col(2);
  const rightC = col(3) + col(4);

  // Very rough shape votes — enough for craft quantities.
  if (topR >= 3 && botR >= 3 && midR <= 2 && leftC >= 2 && rightC >= 2) return 0;
  if (topR >= 2 && midR >= 2 && botR >= 2 && rightC >= midC) {
    if (leftC <= 2 && topR >= 3) return 3;
  }
  if (leftC >= 3 && midR >= 2 && topR >= 1 && botR <= 2) return 4;
  if (topR >= 3 && midR >= 2 && botR >= 2 && leftC >= rightC) return 5;
  if (topR >= 2 && midR >= 2 && botR >= 2 && leftC >= 3) return 6;
  if (topR >= 3 && midR <= 2 && botR <= 2 && rightC >= 2) return 7;
  if (topR >= 3 && midR >= 3 && botR >= 3 && leftC >= 2 && rightC >= 2) return 8;
  if (topR >= 3 && midR >= 2 && botR >= 2 && rightC >= 3) return 9;
  if (topR >= 2 && midR >= 1 && botR >= 2) return 2;

  // Fallback: thin → 1, else refuse
  if (w <= 4) return 1;
  return null;
};

const groupsToInt = (
  image: ImageLike,
  bar: Area,
  groups: InkGroup[],
): number | null => {
  if (groups.length > 2) return null;
  let value = 0;
  for (const g of groups) {
    const digit = classifyDigitGlyph(
      image,
      g.left,
      g.right,
      bar.y,
      bar.y + bar.height - 1,
    );
    if (digit === null) return null;
    value = value * 10 + digit;
  }
  return value;
};

/**
 * White artefact-name band under the title (left of centre, above the bar).
 */
export const findCraftNameBand = (
  image: ImageLike,
  bar?: Area | null,
): CraftNameBand | null => {
  const barY = bar?.y ?? Math.floor(image.height * 0.6);
  const y0 = Math.floor(image.height * 0.2);
  const y1 = Math.max(y0 + 10, barY - 20);
  const x1 = Math.floor(image.width * 0.7);

  const rows: { y: number; minX: number; maxX: number; count: number }[] = [];
  for (let y = y0; y < y1; y += 1) {
    let minX = image.width;
    let maxX = -1;
    let count = 0;
    for (let x = Math.floor(image.width * 0.12); x < x1; x += 1) {
      if (!isWhiteInk(image.data, (y * image.width + x) * 4, 200)) continue;
      if (x < minX) minX = x;
      maxX = x;
      count += 1;
    }
    // Name line is denser than the thin "Done" / xp crumbs.
    if (count >= 25 && maxX - minX >= 60) {
      rows.push({ y, minX, maxX, count });
    }
  }
  if (!rows.length) return null;

  let best = rows.slice(0, 1);
  let cur = rows.slice(0, 1);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].y - cur.at(-1)!.y <= 2) cur.push(rows[i]);
    else {
      if (cur.reduce((s, r) => s + r.count, 0) > best.reduce((s, r) => s + r.count, 0)) {
        best = cur;
      }
      cur = [rows[i]];
    }
  }
  if (cur.reduce((s, r) => s + r.count, 0) > best.reduce((s, r) => s + r.count, 0)) {
    best = cur;
  }

  const height = best.at(-1)!.y - best[0].y + 1;
  if (height < 8 || height > 24) return null;

  const minX = Math.min(...best.map((r) => r.minX));
  const maxX = Math.max(...best.map((r) => r.maxX));
  return {
    x: Math.max(0, minX - 4),
    y: Math.max(0, best[0].y - 2),
    width: Math.min(image.width - minX, maxX - minX + 10),
    height: height + 4,
  };
};

export type CraftReadResult = {
  progress: CraftProgress | null;
  nameBand: CraftNameBand | null;
};

/** Locate progress + name band inside a craft / restoration popup image. */
export const readCraftPopup = (image: ImageLike): CraftReadResult => {
  const progress = readCraftProgress(image);
  const nameBand = findCraftNameBand(image, progress?.bar ?? null);
  return { progress, nameBand };
};

/** Crop a sub-rect into a new buffer (RGBA). */
export const cropImage = (
  image: ImageLike,
  area: Area,
): { data: Uint8ClampedArray; width: number; height: number } => {
  const x0 = Math.max(0, area.x);
  const y0 = Math.max(0, area.y);
  const w = Math.min(area.width, image.width - x0);
  const h = Math.min(area.height, image.height - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = ((y0 + y) * image.width + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      data[di] = image.data[si];
      data[di + 1] = image.data[si + 1];
      data[di + 2] = image.data[si + 2];
      data[di + 3] = 255;
    }
  }
  return { data, width: w, height: h };
};

export const nearestScale = (
  src: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  scale: number,
): { data: Uint8ClampedArray; width: number; height: number } => {
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
  return { data, width: w, height: h };
};
