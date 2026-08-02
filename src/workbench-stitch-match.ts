/**
 * Archaeologist’s Workbench stitch matcher — copied from
 * scripts/diag/rebuild-stitch-canvas.mjs / audit.mjs (offline that hit 53/53).
 *
 * Soft-locate (workbench-soft-locate*, parallel) → keep on lattice → grid from
 * kept bounds → competitive closed-set assign on damaged artefacts.
 * Bank / material-storage must not call this.
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
import { softLocateAllSprites } from "./workbench-soft-locate.ts";

export type WorkbenchStitchTarget = {
  fit: MatchSprite;
  image: ImageData;
  ref: unknown;
  name?: string;
};

export type WorkbenchStitchClaim = {
  target: WorkbenchStitchTarget;
  centreX: number;
  centreY: number;
  row: number;
  column: number;
  exact: boolean;
  precision: number;
  recall: number;
};

export type WorkbenchStitchUnresolved = {
  x: number;
  y: number;
  row: number;
  column: number;
  guess: WorkbenchStitchTarget | null;
  precision: number;
  recall: number;
};

export type WorkbenchStitchResult = {
  latticeX: { origin: number; pitch: number };
  latticeY: { origin: number; pitch: number };
  columns: number[];
  rows: number[];
  slotSize: number;
  claims: WorkbenchStitchClaim[];
  unresolved: WorkbenchStitchUnresolved[];
};

const MIN_INK = 40;
const CLOSED_SET = true;
/** Left storage pane is always five columns. */
const WORKBENCH_COLUMNS = 5;

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

export type MatchWorkbenchOptions = {
  /** Soft-locate parallelism. Default true. Set false for benches. */
  parallelSoftLocate?: boolean;
};

/**
 * Exact algorithm from rebuild-stitch-canvas.mjs (offline workbench audit).
 * Soft-locate runs via workbench-soft-locate (parallel when possible).
 */
export const matchWorkbenchStorageStitch = async (
  screen: ImageData,
  targets: WorkbenchStitchTarget[],
  onProgress?: (checked: number, total: number) => void,
  options: MatchWorkbenchOptions = {},
): Promise<WorkbenchStitchResult> => {
  const softTargets = targets.filter((target) => target.fit);

  const anchors = await softLocateAllSprites(
    screen,
    softTargets.map((target) => target.fit),
    onProgress,
    { parallel: options.parallelSoftLocate },
  );

  const gx = fitAxis(anchors.map((a) => a.centreX));
  const gy = fitAxis(anchors.map((a) => a.centreY));
  if (!gx || !gy) {
    throw new Error(
      "Could not fit the workbench storage grid on the stitched image. Keep damaged artefacts visible and try again.",
    );
  }

  const kept = anchors.filter(
    (a) => Math.abs(residual(a.centreX, gx)) <= 2.5 && Math.abs(residual(a.centreY, gy)) <= 2.5,
  );
  if (kept.length < 4) {
    throw new Error(
      "Could not fit the workbench storage grid on the stitched image. Keep damaged artefacts visible and try again.",
    );
  }

  const bounds = {
    x0: Math.min(...kept.map((a) => a.centreX)),
    x1: Math.max(...kept.map((a) => a.centreX)),
    y0: Math.min(...kept.map((a) => a.centreY)),
    y1: Math.max(...kept.map((a) => a.centreY)),
  };

  let columns = lineOf(gx, bounds.x0 - gx.pitch / 2, bounds.x1 + gx.pitch / 2);
  // Never walk into the backpack pane if the crop was too wide.
  if (columns.length > WORKBENCH_COLUMNS) {
    columns = columns.slice(0, WORKBENCH_COLUMNS);
  }
  const rows = lineOf(gy, bounds.y0 - gy.pitch / 2, bounds.y1 + gy.pitch / 2);
  const slotSize = Math.max(
    32,
    Math.min(36, Math.round(Math.min(gx.pitch, gy.pitch) - 8)),
  );

  const latticeX = { origin: gx.phase, pitch: gx.pitch };
  const latticeY = { origin: gy.phase, pitch: gy.pitch };

  type Cell = {
    r: number;
    c: number;
    centreX: number;
    centreY: number;
    slot: SlotContent;
    nearest: { target: WorkbenchStitchTarget; fit: Fit } | null;
  };

  const cells: Cell[] = [];
  const ranked: {
    cell: Cell;
    target: WorkbenchStitchTarget;
    fit: Fit;
    verdict: "exact" | "redrawn";
  }[] = [];

  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < columns.length; c += 1) {
      const centreX = columns[c];
      const centreY = rows[r];
      const slot = readSlot(screen, centreX, centreY, slotSize);
      // Offline: ink count only (no cellContent variance probe).
      if (slot.count < MIN_INK) continue;
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
  const takenTarget = new Set<WorkbenchStitchTarget>();
  const claims: WorkbenchStitchClaim[] = [];
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

  const unresolved: WorkbenchStitchUnresolved[] = [];
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
  };
};
