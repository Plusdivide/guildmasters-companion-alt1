/**
 * Material Storage stitch matcher — copied from
 * scripts/diag/rebuild-materials-canvas.mjs (offline audit that scores 40/0).
 *
 * Soft-locate anchors → keep on lattice → full grid → padlocks blanked →
 * competitive closed-set assign. Bank / workbench must not call this.
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

export type MaterialStitchTarget = {
  fit: MatchSprite;
  image: ImageData;
  ref: unknown;
  /** Sprite file stem for offline audits (e.g. mat-orthenglass). */
  name?: string;
};

export type MaterialStitchClaim = {
  target: MaterialStitchTarget;
  centreX: number;
  centreY: number;
  row: number;
  column: number;
  exact: boolean;
  precision: number;
  recall: number;
};

export type MaterialStitchUnresolved = {
  x: number;
  y: number;
  row: number;
  column: number;
  guess: MaterialStitchTarget | null;
  precision: number;
  recall: number;
};

export type MaterialStitchBlank = {
  x: number;
  y: number;
  row: number;
  column: number;
  kind: "lock" | "empty";
};

export type MaterialStitchResult = {
  latticeX: { origin: number; pitch: number };
  latticeY: { origin: number; pitch: number };
  columns: number[];
  rows: number[];
  slotSize: number;
  claims: MaterialStitchClaim[];
  unresolved: MaterialStitchUnresolved[];
  blanks: MaterialStitchBlank[];
};

const TOLERANCE = 30;
const TRUST = 0.95;
const MIN_INK = 40;
const PADLOCK_MIN = 0.75;
const CLOSED_SET = true;

const precisionAt = (
  screen: ImageData,
  sprite: MatchSprite,
  ox: number,
  oy: number,
  step: number,
): number => {
  let within = 0;
  let compared = 0;
  for (let i = 0; i < sprite.count; i += step) {
    const x = ox + sprite.xs[i];
    const y = oy + sprite.ys[i];
    compared += 1;
    if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) continue;
    const o = (y * screen.width + x) * 4;
    if (
      Math.abs(screen.data[o] - sprite.rs[i]) <= TOLERANCE &&
      Math.abs(screen.data[o + 1] - sprite.gs[i]) <= TOLERANCE &&
      Math.abs(screen.data[o + 2] - sprite.bs[i]) <= TOLERANCE
    ) {
      within += 1;
    }
  }
  return compared ? within / compared : 0;
};

const residual = (
  value: number,
  axis: { pitch: number; phase: number },
): number =>
  value - (axis.phase + Math.round((value - axis.phase) / axis.pitch) * axis.pitch);

const fitAxis = (
  values: number[],
): { pitch: number; phase: number } | null => {
  if (values.length < 2) return null;
  let best: {
    pitch: number;
    phase: number;
    inliers: number;
    err: number;
  } | null = null;
  for (let pitch = 30; pitch <= 52; pitch += 0.02) {
    for (let phase = 0; phase < pitch; phase += 0.25) {
      const axis = { pitch, phase };
      let inliers = 0;
      let err = 0;
      for (const value of values) {
        const d = residual(value, axis);
        if (Math.abs(d) <= 2) {
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
  const inliers = values.filter((value) => Math.abs(residual(value, best!)) <= 2);
  let refined: { pitch: number; phase: number; err: number } = {
    pitch: best.pitch,
    phase: best.phase,
    err: best.err,
  };
  for (let pitch = best.pitch - 0.5; pitch <= best.pitch + 0.5; pitch += 0.005) {
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
    for (const value of inliers) err += residual(value, axis) ** 2;
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

const cellContent = (
  screen: ImageData,
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
      if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) continue;
      const index = (y * screen.width + x) * 4;
      const lum = screen.data[index] + screen.data[index + 1] + screen.data[index + 2];
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

/**
 * Exact algorithm from rebuild-materials-canvas.mjs.
 * Live scan and offline audit both call this — one implementation.
 */
export const matchMaterialStorageStitch = async (
  screen: ImageData,
  targets: MaterialStitchTarget[],
  padlock: MatchSprite | null,
  onProgress?: (checked: number, total: number) => void,
): Promise<MaterialStitchResult> => {
  const softTargets = targets.filter((target) => target.fit);

  const anchors: { centreX: number; centreY: number }[] = [];
  for (let index = 0; index < softTargets.length; index += 1) {
    const sprite = softTargets[index].fit;
    const seeds: { x: number; y: number; p: number }[] = [];
    for (let y = 0; y + sprite.height < screen.height; y += 2) {
      for (let x = 0; x + sprite.width < screen.width; x += 2) {
        const p = precisionAt(screen, sprite, x, y, 7);
        if (p >= 0.8) seeds.push({ x, y, p });
      }
    }
    seeds.sort((a, b) => b.p - a.p);
    let best = { x: 0, y: 0, p: -1 };
    for (const seed of seeds.slice(0, 120)) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const p = precisionAt(screen, sprite, seed.x + dx, seed.y + dy, 1);
          if (p > best.p) best = { x: seed.x + dx, y: seed.y + dy, p };
        }
      }
    }
    if (best.p >= TRUST) {
      anchors.push({
        centreX: best.x + sprite.width / 2,
        centreY: best.y + sprite.height / 2,
      });
    }
    if (index % 6 === 0) {
      onProgress?.(index, softTargets.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const gx = fitAxis(anchors.map((a) => a.centreX));
  const gy = fitAxis(anchors.map((a) => a.centreY));
  if (!gx || !gy) {
    throw new Error(
      "Could not fit the material storage grid on the stitched image. Try scrolling with more overlap.",
    );
  }

  // Offline: drop anchors that do not sit on the fitted lattice.
  const kept = anchors.filter(
    (a) => Math.abs(residual(a.centreX, gx)) <= 2.5 && Math.abs(residual(a.centreY, gy)) <= 2.5,
  );
  if (kept.length < 3) {
    throw new Error(
      "Could not fit the material storage grid on the stitched image. Try scrolling with more overlap.",
    );
  }

  const latticeX = { origin: gx.phase, pitch: gx.pitch };
  const latticeY = { origin: gy.phase, pitch: gy.pitch };
  const columns = lineOf(gx, gx.pitch * 0.45, screen.width - gx.pitch * 0.45);
  const rows = lineOf(gy, gy.pitch * 0.45, screen.height - gy.pitch * 0.45);
  const slotSize = Math.max(
    32,
    Math.min(36, Math.round(Math.min(gx.pitch, gy.pitch) - 8)),
  );

  const isPadlock = (centreX: number, centreY: number): boolean => {
    if (!padlock) return false;
    const slot = readSlot(screen, centreX, centreY, Math.max(slotSize, 36));
    return measureFit(screen, padlock, slot, centreX, centreY).precision >= PADLOCK_MIN;
  };

  type Cell = {
    r: number;
    c: number;
    centreX: number;
    centreY: number;
    slot: SlotContent;
    nearest: { target: MaterialStitchTarget; fit: Fit } | null;
  };

  const cells: Cell[] = [];
  const blanks: MaterialStitchBlank[] = [];
  const ranked: {
    cell: Cell;
    target: MaterialStitchTarget;
    fit: Fit;
    verdict: "exact" | "redrawn";
  }[] = [];

  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < columns.length; c += 1) {
      const centreX = columns[c];
      const centreY = rows[r];
      if (isPadlock(centreX, centreY)) {
        blanks.push({ x: centreX, y: centreY, row: r, column: c, kind: "lock" });
        continue;
      }
      const content = cellContent(screen, centreX, centreY);
      const slot = readSlot(screen, centreX, centreY, slotSize);
      const occupied =
        !(content === "empty" && slot.count < MIN_INK) &&
        !(slot.count < Math.max(20, MIN_INK / 2) && content === "empty");
      if (!occupied) {
        blanks.push({ x: centreX, y: centreY, row: r, column: c, kind: "empty" });
        continue;
      }
      const cell: Cell = {
        r,
        c,
        centreX,
        centreY,
        slot,
        nearest: null,
      };
      cells.push(cell);
      for (const target of softTargets) {
        if (!roughlyFits(screen, target.fit, slot, centreX, centreY)) continue;
        const fit = measureFit(screen, target.fit, slot, centreX, centreY);
        if (!cell.nearest || fitStrength(fit) > fitStrength(cell.nearest.fit)) {
          cell.nearest = { target, fit };
        }
        const verdict = judgeFit(fit, target.fit, CLOSED_SET);
        if (verdict) ranked.push({ cell, target, fit, verdict });
      }
    }
  }

  ranked.sort(
    (a, b) =>
      rankOf(b.verdict, b.fit, b.target.fit, b.cell.slot) -
      rankOf(a.verdict, a.fit, a.target.fit, a.cell.slot),
  );

  const takenCell = new Set<string>();
  const takenTarget = new Set<MaterialStitchTarget>();
  const claims: MaterialStitchClaim[] = [];
  for (const entry of ranked) {
    const key = `${entry.cell.r},${entry.cell.c}`;
    if (takenCell.has(key) || takenTarget.has(entry.target)) continue;
    takenCell.add(key);
    takenTarget.add(entry.target);
    claims.push({
      target: entry.target,
      centreX: entry.cell.centreX,
      centreY: entry.cell.centreY,
      row: entry.cell.r,
      column: entry.cell.c,
      exact: entry.verdict === "exact",
      precision: entry.fit.precision,
      recall: entry.fit.recall,
    });
  }

  const unresolved: MaterialStitchUnresolved[] = [];
  for (const cell of cells) {
    if (takenCell.has(`${cell.r},${cell.c}`)) continue;
    const near = cell.nearest;
    unresolved.push({
      x: cell.centreX,
      y: cell.centreY,
      row: cell.r,
      column: cell.c,
      guess: near ? near.target : null,
      precision: near ? near.fit.precision : 0,
      recall: near ? near.fit.recall : 0,
    });
  }

  onProgress?.(softTargets.length, softTargets.length);

  return {
    latticeX,
    latticeY,
    columns,
    rows,
    slotSize,
    claims,
    unresolved,
    blanks,
  };
};
