/**
 * Offline-parity matcher for a stitched Bank still (left item grid only).
 * Soft-locate anchors → fine pitch/phase lattice → competitive assign.
 * Open-set: unmatched occupied cells stay unresolved (bank junk / bad sprites).
 */
import {
  fitStrength,
  judgeFit,
  measureFit,
  rankOf,
  readSlot,
  roughlyFits,
  type Fit,
  type MatchSprite,
  type SlotContent,
} from "./matcher.ts";
import { softLocateAllSprites } from "./bank-soft-locate.ts";

export type BankStitchTarget = {
  fit: MatchSprite;
  image: ImageData;
  ref: unknown;
};

export type BankStitchClaim = {
  target: BankStitchTarget;
  centreX: number;
  centreY: number;
  exact: boolean;
  precision: number;
};

export type BankStitchUnresolved = {
  x: number;
  y: number;
  guess: BankStitchTarget | null;
  precision: number;
  recall: number;
};

export type BankStitchResult = {
  latticeX: { origin: number; pitch: number };
  latticeY: { origin: number; pitch: number };
  columns: number[];
  rows: number[];
  slotSize: number;
  claims: BankStitchClaim[];
  unresolved: BankStitchUnresolved[];
  /** Slot centres ignored as non-archaeology (e.g. tetracompass pieces). */
  blanks: { x: number; y: number }[];
};

const SLOT_MIN_INK = 40;
/**
 * Bank is open-set junk mixed with archaeology. Closed-set soft (0.78) alone
 * invents names on dark lore books; open-set alone drops dull real artefacts.
 * Accept either path, but redrawn needs real slot coverage — r4c10 lore book
 * hit projection-attuner at 78% / 48% recall; genuine redraws sit ≥ ~75%.
 */
const BANK_REDRAWN_MIN_RECALL = 0.55;
/** Tetracompass pieces / similar — treat as blank for archaeology matching. */
const BLANK_PRECISION = 0.85;
const BLANK_RECALL = 0.35;

const cellContent = (
  pixels: ImageData,
  centreX: number,
  centreY: number,
): "empty" | "faint" | "filled" => {
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

const axisResidual = (
  value: number,
  axis: { pitch: number; phase: number },
): number =>
  value - (axis.phase + Math.round((value - axis.phase) / axis.pitch) * axis.pitch);

const fitAxis = (
  values: number[],
): { pitch: number; phase: number } | null => {
  if (values.length < 2) return null;
  let best: { pitch: number; phase: number; inliers: number; err: number } | null =
    null;
  for (let pitch = 40; pitch <= 48; pitch += 0.02) {
    for (let phase = 0; phase < pitch; phase += 0.25) {
      const axis = { pitch, phase };
      let inliers = 0;
      let err = 0;
      for (const value of values) {
        const d = axisResidual(value, axis);
        if (Math.abs(d) <= 2.5) {
          inliers += 1;
          err += d * d;
        }
      }
      if (
        !best ||
        inliers > best.inliers ||
        (inliers === best.inliers && err < best.err)
      ) {
        best = { pitch, phase, inliers, err };
      }
    }
  }
  if (!best) return null;
  const inliers = values.filter((value) => Math.abs(axisResidual(value, best!)) <= 2.5);
  let refined: { pitch: number; phase: number; err: number } = {
    pitch: best.pitch,
    phase: best.phase,
    err: best.err,
  };
  for (let pitch = best.pitch - 0.4; pitch <= best.pitch + 0.4; pitch += 0.005) {
    let sin = 0;
    let cos = 0;
    for (const value of inliers) {
      const a = (2 * Math.PI * value) / pitch;
      sin += Math.sin(a);
      cos += Math.cos(a);
    }
    const phase = (((Math.atan2(sin, cos) * pitch) / (2 * Math.PI)) + pitch) % pitch;
    const axis = { pitch, phase };
    let err = 0;
    for (const value of inliers) err += axisResidual(value, axis) ** 2;
    if (err < refined.err) refined = { pitch, phase, err };
  }
  return { pitch: refined.pitch, phase: refined.phase };
};

const lineOf = (
  axis: { pitch: number; phase: number },
  lo: number,
  hi: number,
): number[] => {
  const out: number[] = [];
  for (let k = Math.floor((lo - axis.phase) / axis.pitch); ; k += 1) {
    const value = axis.phase + k * axis.pitch;
    if (value > hi) break;
    if (value >= lo) out.push(value);
  }
  return out;
};

export type MatchBankOptions = {
  blankSprites?: MatchSprite[];
  /** Soft-locate parallelism. Default true. Set false for benches. */
  parallelSoftLocate?: boolean;
};

export const matchBankStorageStitch = async (
  pixels: ImageData,
  targets: BankStitchTarget[],
  onProgress?: (checked: number, total: number) => void,
  options: MatchBankOptions = {},
): Promise<BankStitchResult> => {
  const softTargets = targets.filter((target) => target.fit);
  const blankSprites = (options.blankSprites ?? []).filter((sprite) => sprite.count > 0);

  const anchors = await softLocateAllSprites(
    pixels,
    softTargets.map((target) => target.fit),
    onProgress,
    { parallel: options.parallelSoftLocate },
  );

  if (anchors.length < 3) {
    return {
      latticeX: { origin: 0, pitch: 44 },
      latticeY: { origin: 0, pitch: 44 },
      columns: [],
      rows: [],
      slotSize: 32,
      claims: [],
      unresolved: [],
      blanks: [],
    };
  }

  const gx = fitAxis(anchors.map((a) => a.centreX));
  const gy = fitAxis(anchors.map((a) => a.centreY));
  if (!gx || !gy) {
    return {
      latticeX: { origin: 0, pitch: 44 },
      latticeY: { origin: 0, pitch: 44 },
      columns: [],
      rows: [],
      slotSize: 32,
      claims: [],
      unresolved: [],
      blanks: [],
    };
  }

  let columns = lineOf(gx, gx.pitch * 0.35, pixels.width - gx.pitch * 0.35);
  let rows = lineOf(gy, gy.pitch * 0.35, pixels.height - gy.pitch * 0.35);
  const slotSize = Math.max(32, Math.min(36, Math.round(Math.min(gx.pitch, gy.pitch) - 8)));

  const isOccupied = (centreX: number, centreY: number, slot?: SlotContent): boolean => {
    const content = readSlot(pixels, centreX, centreY, slotSize);
    const ink = slot ?? content;
    const contentProbe = cellContent(pixels, centreX, centreY);
    return (
      !(contentProbe === "empty" && ink.count < SLOT_MIN_INK) &&
      !(ink.count < Math.max(20, SLOT_MIN_INK / 2) && contentProbe === "empty")
    );
  };

  while (columns.length > 1 && !rows.some((y) => isOccupied(columns.at(-1)!, y))) {
    columns.pop();
  }
  while (columns.length > 1 && !rows.some((y) => isOccupied(columns[0]!, y))) {
    columns.shift();
  }
  while (rows.length > 1 && !columns.some((x) => isOccupied(x, rows.at(-1)!))) {
    rows.pop();
  }
  while (rows.length > 1 && !columns.some((x) => isOccupied(x, rows[0]!))) {
    rows.shift();
  }

  type Pick = {
    centreX: number;
    centreY: number;
    slot: SlotContent;
    target: BankStitchTarget;
    fit: Fit;
    verdict: "exact" | "redrawn";
  };
  const ranked: Pick[] = [];
  const nearestByCell = new Map<string, { target: BankStitchTarget; fit: Fit }>();
  const blanks: { x: number; y: number }[] = [];
  const blankCells = new Set<string>();

  const isBlankSprite = (slot: SlotContent, centreX: number, centreY: number): boolean => {
    for (const sprite of blankSprites) {
      if (!roughlyFits(pixels, sprite, slot, centreX, centreY)) continue;
      const fit = measureFit(pixels, sprite, slot, centreX, centreY);
      if (fit.precision >= BLANK_PRECISION && fit.recall >= BLANK_RECALL) return true;
      // Needle/dial pieces are small — accept strong precision alone.
      if (fit.precision >= 0.88 && fit.recall >= 0.3) return true;
    }
    return false;
  };

  for (const centreY of rows) {
    for (const centreX of columns) {
      const slot = readSlot(pixels, centreX, centreY, slotSize);
      if (!isOccupied(centreX, centreY, slot)) continue;
      const key = `${centreX.toFixed(1)},${centreY.toFixed(1)}`;
      if (isBlankSprite(slot, centreX, centreY)) {
        blanks.push({ x: centreX, y: centreY });
        blankCells.add(key);
        continue;
      }
      let nearest: { target: BankStitchTarget; fit: Fit } | null = null;
      for (const target of softTargets) {
        if (!roughlyFits(pixels, target.fit, slot, centreX, centreY)) continue;
        const fit = measureFit(pixels, target.fit, slot, centreX, centreY);
        if (!nearest || fitStrength(fit) > fitStrength(nearest.fit)) {
          nearest = { target, fit };
        }
        // Prefer closed-set (catches dull damaged art); fall back to open-set
        // (rich redraws below 78%). Either redrawn path needs BANK_REDRAWN_MIN_RECALL.
        const closed = judgeFit(fit, target.fit, true);
        const open = closed ? null : judgeFit(fit, target.fit, false);
        const verdict =
          closed === "exact" || open === "exact"
            ? ("exact" as const)
            : closed === "redrawn" || open === "redrawn"
              ? ("redrawn" as const)
              : null;
        if (!verdict) continue;
        if (verdict === "redrawn" && fit.recall < BANK_REDRAWN_MIN_RECALL) continue;
        ranked.push({ centreX, centreY, slot, target, fit, verdict });
      }
      if (nearest) nearestByCell.set(key, nearest);
    }
  }

  ranked.sort(
    (a, b) =>
      rankOf(b.verdict, b.fit, b.target.fit, b.slot) -
      rankOf(a.verdict, a.fit, a.target.fit, a.slot),
  );

  const takenTargets = new Set<BankStitchTarget>();
  const takenCells = new Set<string>();
  const cellKey = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;

  const claims: BankStitchClaim[] = [];
  for (const pick of ranked) {
    const key = cellKey(pick.centreX, pick.centreY);
    if (blankCells.has(key) || takenCells.has(key) || takenTargets.has(pick.target)) {
      continue;
    }
    takenCells.add(key);
    takenTargets.add(pick.target);
    claims.push({
      target: pick.target,
      centreX: pick.centreX,
      centreY: pick.centreY,
      exact: pick.verdict === "exact",
      precision: pick.fit.precision,
    });
  }

  const unresolved: BankStitchUnresolved[] = [];
  for (const centreY of rows) {
    for (const centreX of columns) {
      const key = cellKey(centreX, centreY);
      if (blankCells.has(key) || takenCells.has(key)) continue;
      const slot = readSlot(pixels, centreX, centreY, slotSize);
      if (!isOccupied(centreX, centreY, slot)) continue;
      const nearest = nearestByCell.get(key);
      unresolved.push({
        x: centreX,
        y: centreY,
        guess: nearest?.target ?? null,
        precision: nearest?.fit.precision ?? 0,
        recall: nearest?.fit.recall ?? 0,
      });
    }
  }

  onProgress?.(softTargets.length, softTargets.length);

  return {
    latticeX: { origin: gx.phase, pitch: gx.pitch },
    latticeY: { origin: gy.phase, pitch: gy.pitch },
    columns,
    rows,
    slotSize,
    claims,
    unresolved,
    blanks,
  };
};
