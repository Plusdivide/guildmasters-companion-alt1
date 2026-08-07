/**
 * Live excavation session for Overview GP/h.
 *
 * Fed by CompanionWatcher dig finds that bump inventory. Idle after
 * IDLE_MS with no finds → “not currently excavating”.
 *
 * Rate uses a session average blended with a short rolling window, then
 * exponential smoothing on the displayed value (same feel as in-game XP/GP
 * trackers — updates often, numbers ease instead of jumping).
 */
const IDLE_MS = 60_000;
/** Cap early-session inflation until enough time has passed. */
const MIN_RATE_MS = 30_000;
/** Recent-activity window mixed into the target rate. */
const ROLLING_MS = 5 * 60_000;
/** Per-second ease toward target (higher = snappier). */
const SMOOTH_PER_SEC = 0.18;

export type ExcavationSnapshot = {
  excavating: boolean;
  gpPerHour: number | null;
  sessionGp: number;
  elapsedMs: number;
  lastFindAt: number | null;
  findCount: number;
};

type FindSample = { at: number; gp: number };

let sessionStart: number | null = null;
let lastFindAt: number | null = null;
let sessionGp = 0;
let findCount = 0;
let finds: FindSample[] = [];
let smoothedGpPerHour: number | null = null;
let lastSmoothAt: number | null = null;

const clearSmoothing = (): void => {
  smoothedGpPerHour = null;
  lastSmoothAt = null;
};

const pruneFinds = (now: number): void => {
  const keepFrom = Math.min(
    now - ROLLING_MS * 2,
    sessionStart ?? now,
  );
  if (finds.length && finds[0].at < keepFrom) {
    finds = finds.filter((f) => f.at >= keepFrom);
  }
};

const targetGpPerHour = (now: number): number => {
  if (sessionStart === null) return 0;
  const elapsedMs = Math.max(0, now - sessionStart);
  const sessionHours = Math.max(elapsedMs, MIN_RATE_MS) / 3_600_000;
  const sessionRate = sessionGp / sessionHours;

  pruneFinds(now);
  const windowStart = now - ROLLING_MS;
  let recentGp = 0;
  for (const f of finds) {
    if (f.at >= windowStart) recentGp += f.gp;
  }
  const windowMs = Math.min(ROLLING_MS, Math.max(elapsedMs, MIN_RATE_MS));
  const recentRate = recentGp / (windowMs / 3_600_000);

  // Early session: trust full average. Later: lean on the rolling window.
  const blend = Math.min(1, elapsedMs / ROLLING_MS) * 0.55;
  return sessionRate * (1 - blend) + recentRate * blend;
};

const easeToward = (target: number, now: number): number => {
  if (smoothedGpPerHour === null || lastSmoothAt === null) {
    smoothedGpPerHour = target;
    lastSmoothAt = now;
    return target;
  }
  const dtSec = Math.max(0, Math.min(2, (now - lastSmoothAt) / 1000));
  lastSmoothAt = now;
  if (dtSec <= 0) return smoothedGpPerHour;
  const alpha = 1 - Math.pow(1 - SMOOTH_PER_SEC, dtSec);
  smoothedGpPerHour += (target - smoothedGpPerHour) * alpha;
  return smoothedGpPerHour;
};

export const noteExcavationValue = (gp: number, quantity = 1): void => {
  const now = Date.now();
  const value = Math.max(0, gp);
  if (
    sessionStart === null ||
    lastFindAt === null ||
    now - lastFindAt > IDLE_MS
  ) {
    sessionStart = now;
    sessionGp = 0;
    findCount = 0;
    finds = [];
    clearSmoothing();
  }
  lastFindAt = now;
  sessionGp += value;
  findCount += Math.max(1, quantity);
  if (value > 0) finds.push({ at: now, gp: value });
};

export const excavationSnapshot = (now = Date.now()): ExcavationSnapshot => {
  if (
    sessionStart === null ||
    lastFindAt === null ||
    now - lastFindAt > IDLE_MS
  ) {
    if (smoothedGpPerHour !== null) clearSmoothing();
    return {
      excavating: false,
      gpPerHour: null,
      sessionGp: 0,
      elapsedMs: 0,
      lastFindAt,
      findCount: 0,
    };
  }

  const elapsedMs = Math.max(0, now - sessionStart);
  const smoothed = easeToward(targetGpPerHour(now), now);
  return {
    excavating: true,
    gpPerHour: Math.round(smoothed),
    sessionGp,
    elapsedMs,
    lastFindAt,
    findCount,
  };
};

export const resetExcavationSession = (): void => {
  sessionStart = null;
  lastFindAt = null;
  sessionGp = 0;
  findCount = 0;
  finds = [];
  clearSmoothing();
};
