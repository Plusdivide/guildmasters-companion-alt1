/**
 * Deciding which item is in a storage slot.
 *
 * The obvious approach — ask how many of a sprite's pixels agree with the screen —
 * does not work on its own, and that single fact drove the design here. The client
 * redraws a lot of item icons slightly differently from the wiki art, so a real
 * match can disagree on a third of its pixels. Lowering the bar to let those in
 * immediately lets false matches through, because a small, dull sprite dropped on
 * a busy icon agrees with almost everything it happens to cover. On a reference
 * bank capture a genuine match and a wrong one both scored 91%.
 *
 * So a fit is measured on three axes instead, and they only convince together:
 *
 *   precision  share of the sprite's own pixels that agree with the screen
 *   recall     share of the slot's content that the sprite's silhouette accounts
 *              for — this is what catches the small-sprite-on-busy-icon case, as
 *              a sprite covering a corner of the icon explains little of it
 *   contrast   how much detail the sprite carries at all, which sets how far its
 *              colours are allowed to drift: a busy icon stays recognisable when
 *              reshaded, a plain one has to stay close or it starts fitting crates
 *
 * Every threshold below was measured against a lossless capture of a bank holding
 * 54 archaeology items, checked by eye. See scripts/diag/match.mjs, which runs the
 * same algorithm offline and prints what it accepts.
 */

/** Per-channel tolerance, matching what Alt1's own image search allows. */
const TOLERANCE = 30;
/**
 * A slot pixel counts as content once any channel differs this much from the
 * slot's background.
 *
 * Per channel, not by brightness. Brightness alone cannot see a dark saturated
 * item on the dark brown slot: an Orthenglass flask reads as luminance 58 against
 * a background of 35, so a plainly visible flask was 1 short of the threshold and
 * its slot was treated as empty and never matched at all.
 *
 * 24 was far too loose the other way. A smoke-cloud scroll's dark-green fill sits
 * only ~11 channels from the brown workbench background, so at 24 the fill was
 * treated as background and only the black outline counted as ink. Every dark
 * silhouette then looked like an "exact" match for the outline, and the slot was
 * claimed as the wrong artefact. 10 includes that green body while empty slots
 * on the same capture still stay under SLOT_MIN_INK.
 */
const INK_DISTANCE = 10;

/**
 * Where the client prints the stack count: the slot's top-left corner, in an 8px
 * digit font. Those pixels belong to the client rather than the item, so they are
 * excluded from both directions of the comparison.
 *
 * This is measured against the *slot*, not against the sprite's own canvas, and
 * that distinction matters more than it looks. Wiki art is trimmed to the item, so
 * a sprite's top rows are not the slot's top rows — clearing them instead threw
 * away a third of the artwork on 465 of 522 sprites and over half on 119 of them,
 * which left small icons with too few pixels to clear the exact threshold and
 * halved the coverage they could possibly explain.
 */
const STACK_ZONE_ROWS = 11;
const STACK_ZONE_WIDTH = 24;

interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const stackZoneOf = (left: number, top: number, size: number): Zone => ({
  x0: left,
  y0: top,
  x1: left + Math.min(STACK_ZONE_WIDTH, size),
  y1: top + Math.min(STACK_ZONE_ROWS, size),
});

const inZone = (zone: Zone | null, x: number, y: number): boolean =>
  zone !== null && x >= zone.x0 && x < zone.x1 && y >= zone.y0 && y < zone.y1;

/** Near-total pixel agreement. Nothing that was a different item came close. */
const EXACT_PRECISION = 0.98;

/**
 * A near-exact match needs little other evidence, but short of total agreement it
 * still has to cover the slot. A dull vial sprite agreed with 91% of the handful
 * of pixels it covered while explaining 9% of the icon under it.
 *
 * The floor deliberately does not apply to an exact match: a small item in a large
 * slot — a dagger, a crossbow — covers barely a quarter of it, and demanding
 * coverage there would throw away the most certain matches we have.
 */
const REDRAWN_PRECISION_ALONE = 0.88;
/**
 * Soft matches at or above this are trusted on a single view. Below it, the
 * session needs another sighting — that is what stopped one soft misread from
 * becoming a permanent phantom name. Talon-3 sits at ~95.3% on the reference
 * capture; zarosian-stein phantoms were sneaking in at ~95% with a lower gate.
 */
export const TRUSTED_SOFT_PRECISION = 0.95;
const RECALL_FLOOR = 0.3;

/** Otherwise the sprite must explain the slot, and detail buys colour latitude. */
const REDRAWN_MIN_RECALL = 0.4;
const RICH_CONTRAST = 45;
const RICH_PRECISION = 0.65;
const PLAIN_CONTRAST = 31;
const PLAIN_PRECISION = 0.78;

/**
 * Used when every item the container can hold is in the sprite set — the
 * workbench holds only damaged artefacts, material storage only materials. There
 * is no untracked junk to guard against, so the bar drops relative to the bank.
 *
 * It has to. Damaged artefacts are drawn as small dull lumps: their median
 * contrast is 21 against 44 for restored art, and only 16 of 229 reach the plain
 * tier. Judging them on tiers measured from restored art rejects most of the
 * workbench outright — a redrawn Peacocking parasol agreeing on 80% of its pixels
 * and covering 60% of its slot was being turned away at contrast 29.4.
 *
 * 0.70 was too far the other way on multi-pass live scroll (wrong soft names
 * merged across views). Stitch-then-match runs once on a continuous still, so
 * that phantom path is gone — closed-set soft can sit at 0.78 again, which is
 * what cleared the reference workbench (peacocking ~84%, ceremonial plume ~87%).
 */
const CLOSED_SET_PRECISION = 0.78;
// Flat closed-set art (contrast < this) must beat CLOSED_SET_PLAIN_PRECISION.
// Was 18 — death-mask sits at ~17.8, so a stitch soft hit (stack digits, join
// seams) fell into the 92% plain path and became the stubborn unmatched cell.
const CLOSED_SET_PLAIN_PRECISION = 0.92;
const CLOSED_SET_MIN_CONTRAST = 16;

/** Cheap pre-check: every eighth pixel is enough to tell "roughly here" from "nowhere near". */
const ROUGH_STEP = 8;
const ROUGH_MIN = 0.5;

/**
 * How far a sprite may sit from where its content says it should be.
 *
 * The starting position is not the middle of the cell. Wiki art is cropped to the
 * item, so the middle of a sprite's canvas is not the middle of the icon the client
 * draws, and the two can differ by more than any small search would cover. Instead
 * the sprite's drawn pixels are lined up with the slot's content — see anchorFor —
 * which is what the crop cannot change, leaving this to absorb only rounding and a
 * pixel or two of shading disagreement at the edges.
 */
export const FIT_RADIUS = 2;

/**
 * How far the content anchor may pull a sprite from the middle of its cell. Ink
 * from a neighbouring icon or a slot border can drag the anchor; past this the
 * sprite would no longer be being tested against this slot at all.
 */
const ANCHOR_LIMIT = 10;
/** Below this much content, the anchor is noise and the cell centre is the better guess. */
const ANCHOR_MIN_INK = 12;

export interface MatchSprite {
  xs: Int16Array;
  ys: Int16Array;
  rs: Uint8Array;
  gs: Uint8Array;
  bs: Uint8Array;
  /** Which pixels the sprite draws at all, indexed row-major. */
  drawn: Uint8Array;
  width: number;
  height: number;
  count: number;
  contrast: number;
  /** Mean colour of opaque pixels — used to break ties between near-identical dark silhouettes. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Middle of the drawn pixels, in sprite coordinates. Survives any crop. */
  centreOfMassX: number;
  centreOfMassY: number;
}

export interface SlotContent {
  /** Content mask over a size x size window, indexed row-major. */
  ink: Uint8Array;
  count: number;
  left: number;
  top: number;
  size: number;
  /** Mean colour of ink pixels — compared to sprite means when ranking near-ties. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Middle of the slot's content, in screen coordinates. */
  centreOfMassX: number;
  centreOfMassY: number;
}

export interface Fit {
  precision: number;
  recall: number;
  x: number;
  y: number;
}

export type FitVerdict = "exact" | "redrawn" | null;

/**
 * Indexes the comparable pixels of a sprite: every fully opaque pixel, with no
 * rows held back. Stack-count pixels are excluded later, by slot position, since
 * only then is it known which part of the artwork the digits actually cover.
 */
export const prepareSprite = (image: ImageData): MatchSprite | null => {
  const total = image.width * image.height;
  const xs = new Int16Array(total);
  const ys = new Int16Array(total);
  const rs = new Uint8Array(total);
  const gs = new Uint8Array(total);
  const bs = new Uint8Array(total);
  const drawn = new Uint8Array(total);

  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let massX = 0;
  let massY = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = y * image.width + x;
      const index = offset * 4;
      if (image.data[index + 3] !== 255) continue;
      drawn[offset] = 1;
      massX += x;
      massY += y;
      xs[count] = x;
      ys[count] = y;
      rs[count] = image.data[index];
      gs[count] = image.data[index + 1];
      bs[count] = image.data[index + 2];
      sumR += image.data[index];
      sumG += image.data[index + 1];
      sumB += image.data[index + 2];
      count += 1;
      const luminance =
        0.299 * image.data[index] + 0.587 * image.data[index + 1] + 0.114 * image.data[index + 2];
      sum += luminance;
      sumSquares += luminance * luminance;
    }
  }
  if (!count) return null;

  const mean = sum / count;
  return {
    xs: xs.subarray(0, count),
    ys: ys.subarray(0, count),
    rs: rs.subarray(0, count),
    gs: gs.subarray(0, count),
    bs: bs.subarray(0, count),
    drawn,
    width: image.width,
    height: image.height,
    count,
    contrast: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)),
    meanR: sumR / count,
    meanG: sumG / count,
    meanB: sumB / count,
    centreOfMassX: massX / count,
    centreOfMassY: massY / count,
  };
};

/**
 * Reads which pixels of a slot hold content rather than background. The
 * background is taken as the median of the ring around the slot, so a slot that
 * is highlighted, striped by a tab edge or lit differently still measures
 * correctly.
 */
export const readSlot = (
  screen: ImageData,
  centreX: number,
  centreY: number,
  size: number,
): SlotContent => {
  const half = Math.floor(size / 2);
  const left = Math.round(centreX) - half;
  const top = Math.round(centreY) - half;

  const ringR: number[] = [];
  const ringG: number[] = [];
  const ringB: number[] = [];
  for (let step = 0; step < size; step += 1) {
    const candidates = [
      [left + step, top],
      [left + step, top + size - 1],
      [left, top + step],
      [left + size - 1, top + step],
    ];
    for (const [x, y] of candidates) {
      if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) continue;
      const index = (y * screen.width + x) * 4;
      ringR.push(screen.data[index]);
      ringG.push(screen.data[index + 1]);
      ringB.push(screen.data[index + 2]);
    }
  }
  if (!ringR.length) {
    return {
      ink: new Uint8Array(size * size),
      count: 0,
      left,
      top,
      size,
      meanR: 0,
      meanG: 0,
      meanB: 0,
      centreOfMassX: centreX,
      centreOfMassY: centreY,
    };
  }
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const backR = median(ringR);
  const backG = median(ringG);
  const backB = median(ringB);

  // The stack count is content, but it is the client's content, so it is left out
  // of the slot's ink. Counting it would make a sprite look as though it failed to
  // explain part of the slot whenever the item happened to be stacked.
  const zone = stackZoneOf(left, top, size);
  const ink = new Uint8Array(size * size);
  let count = 0;
  let massX = 0;
  let massY = 0;
  const inkR: number[] = [];
  const inkG: number[] = [];
  const inkB: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = left + x;
      const sy = top + y;
      if (sx < 0 || sy < 0 || sx >= screen.width || sy >= screen.height) continue;
      if (inZone(zone, sx, sy)) continue;
      const index = (sy * screen.width + sx) * 4;
      const apart = Math.max(
        Math.abs(screen.data[index] - backR),
        Math.abs(screen.data[index + 1] - backG),
        Math.abs(screen.data[index + 2] - backB),
      );
      if (apart <= INK_DISTANCE) continue;
      ink[y * size + x] = 1;
      massX += sx;
      massY += sy;
      inkR.push(screen.data[index]);
      inkG.push(screen.data[index + 1]);
      inkB.push(screen.data[index + 2]);
      count += 1;
    }
  }
  return {
    ink,
    count,
    left,
    top,
    size,
    // Median, not mean: a few brown padding pixels at the edge of a tight crop
    // must not pull the colour toward the background.
    meanR: count ? median(inkR) : 0,
    meanG: count ? median(inkG) : 0,
    meanB: count ? median(inkB) : 0,
    centreOfMassX: count ? massX / count : centreX,
    centreOfMassY: count ? massY / count : centreY,
  };
};

/**
 * Vertical span of drawn pixels in a slot, in pixels. A full icon fills most of
 * the window; a row clipped by the scroll viewport only paints a thin band —
 * that is what session corroboration needs to reject, not every item that
 * happens to sit on the top or bottom visible row.
 */
export const slotInkHeight = (slot: SlotContent): number => {
  const range = slotInkYRange(slot);
  return range ? range.maxY - range.minY + 1 : 0;
};

/** Top and bottom ink rows in the slot window, or null when empty. */
export const slotInkYRange = (
  slot: SlotContent,
): { minY: number; maxY: number } | null => {
  let minY = slot.size;
  let maxY = -1;
  for (let y = 0; y < slot.size; y += 1) {
    for (let x = 0; x < slot.size; x += 1) {
      if (!slot.ink[y * slot.size + x]) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxY >= minY ? { minY, maxY } : null;
};

/**
 * The positions worth trying the sprite at, best guess first.
 *
 * The client centres an icon in its slot, so centring the sprite is usually right
 * and is tried first. It is not always right: wiki art is cropped to the item, and
 * if that crop is tighter on one side than the other, the middle of the sprite is
 * not the middle of the icon. So the sprite's drawn pixels lined up with the slot's
 * content is offered as a second guess, which no crop can affect.
 *
 * Both are offered rather than just the second because the content anchor is the
 * weaker guess in practice — slot borders and neighbouring icons drag it, and on a
 * reference bank capture using it alone lost four matches that centring found.
 */
const anchorsFor = (
  sprite: MatchSprite,
  slot: SlotContent,
  centreX: number,
  centreY: number,
): { x: number; y: number }[] => {
  const centred = {
    x: Math.round(centreX - sprite.width / 2),
    y: Math.round(centreY - sprite.height / 2),
  };
  if (slot.count < ANCHOR_MIN_INK) return [centred];

  const clamp = (value: number, middle: number) =>
    Math.round(Math.min(middle + ANCHOR_LIMIT, Math.max(middle - ANCHOR_LIMIT, value)));
  const aligned = {
    x: clamp(slot.centreOfMassX - sprite.centreOfMassX, centred.x),
    y: clamp(slot.centreOfMassY - sprite.centreOfMassY, centred.y),
  };
  // Only worth a second pass if it looks somewhere the first one will not reach.
  const reach = FIT_RADIUS * 2;
  if (Math.abs(aligned.x - centred.x) <= reach && Math.abs(aligned.y - centred.y) <= reach) {
    return [centred];
  }
  return [centred, aligned];
};

const precisionAt = (
  screen: ImageData,
  sprite: MatchSprite,
  originX: number,
  originY: number,
  step: number,
  zone: Zone | null,
): number => {
  let within = 0;
  let compared = 0;
  for (let i = 0; i < sprite.count; i += step) {
    const x = originX + sprite.xs[i];
    const y = originY + sprite.ys[i];
    // Pixels under the stack count are not the item's, so they are neither
    // credited nor charged.
    if (inZone(zone, x, y)) continue;
    compared += 1;
    if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) continue;
    const index = (y * screen.width + x) * 4;
    if (
      Math.abs(screen.data[index] - sprite.rs[i]) <= TOLERANCE &&
      Math.abs(screen.data[index + 1] - sprite.gs[i]) <= TOLERANCE &&
      Math.abs(screen.data[index + 2] - sprite.bs[i]) <= TOLERANCE
    ) {
      within += 1;
    }
  }
  return compared ? within / compared : 0;
};

/**
 * Cheap rejection before the real compare. This searches the same offsets as
 * measureFit, because a sprite sitting two pixels off would otherwise be thrown
 * out before it was ever measured properly.
 */
export const roughlyFits = (
  screen: ImageData,
  sprite: MatchSprite,
  slot: SlotContent,
  centreX: number,
  centreY: number,
): boolean => {
  const zone = stackZoneOf(slot.left, slot.top, slot.size);
  for (const base of anchorsFor(sprite, slot, centreX, centreY)) {
    for (let dy = -FIT_RADIUS; dy <= FIT_RADIUS; dy += 1) {
      for (let dx = -FIT_RADIUS; dx <= FIT_RADIUS; dx += 1) {
        if (precisionAt(screen, sprite, base.x + dx, base.y + dy, ROUGH_STEP, zone) >= ROUGH_MIN) {
          return true;
        }
      }
    }
  }
  return false;
};

/** Best precision over the offset window, plus the recall at that position. */
export const measureFit = (
  screen: ImageData,
  sprite: MatchSprite,
  slot: SlotContent,
  centreX: number,
  centreY: number,
): Fit => {
  const zone = stackZoneOf(slot.left, slot.top, slot.size);
  const anchors = anchorsFor(sprite, slot, centreX, centreY);

  let precision = -1;
  let bestX = anchors[0].x;
  let bestY = anchors[0].y;
  for (const base of anchors) {
    for (let dy = -FIT_RADIUS; dy <= FIT_RADIUS; dy += 1) {
      for (let dx = -FIT_RADIUS; dx <= FIT_RADIUS; dx += 1) {
        const found = precisionAt(screen, sprite, base.x + dx, base.y + dy, 1, zone);
        if (found > precision) {
          precision = found;
          bestX = base.x + dx;
          bestY = base.y + dy;
        }
      }
    }
  }

  let covered = 0;
  if (slot.count) {
    for (let y = 0; y < slot.size; y += 1) {
      for (let x = 0; x < slot.size; x += 1) {
        if (!slot.ink[y * slot.size + x]) continue;
        const sx = slot.left + x - bestX;
        const sy = slot.top + y - bestY;
        if (sx < 0 || sy < 0 || sx >= sprite.width || sy >= sprite.height) continue;
        if (sprite.drawn[sy * sprite.width + sx]) covered += 1;
      }
    }
  }

  return {
    precision: Math.max(0, precision),
    recall: slot.count ? covered / slot.count : 0,
    x: bestX,
    y: bestY,
  };
};

/**
 * Whether a measured fit is good enough to name the slot, and on what grounds.
 *
 * `closedSet` says every item the container can hold is one we have a sprite for,
 * which relaxes the detail requirement — see CLOSED_SET_PRECISION.
 */
export const judgeFit = (fit: Fit, sprite: MatchSprite, closedSet = false): FitVerdict => {
  // Very flat closed-set art agrees with almost any dark icon. Still allow a
  // strong soft hit — stitch-once no longer merges weak multi-view phantoms.
  if (closedSet && sprite.contrast < 12) {
    if (fit.precision >= EXACT_PRECISION && fit.recall >= 0.9) return "exact";
    if (fit.precision >= CLOSED_SET_PLAIN_PRECISION && fit.recall >= RECALL_FLOOR) {
      return "redrawn";
    }
    return null;
  }

  if (fit.precision >= EXACT_PRECISION) return "exact";
  if (fit.recall < RECALL_FLOOR) return null;
  // Flat closed-set sprites must clear CLOSED_SET_PLAIN_PRECISION, not this
  // near-exact shortcut — otherwise dull paintings invent phantoms at 88–91%.
  if (
    fit.precision >= REDRAWN_PRECISION_ALONE &&
    !(closedSet && sprite.contrast < CLOSED_SET_MIN_CONTRAST)
  ) {
    return "redrawn";
  }
  if (fit.recall < REDRAWN_MIN_RECALL) return null;
  if (closedSet) {
    const needed =
      sprite.contrast >= CLOSED_SET_MIN_CONTRAST
        ? CLOSED_SET_PRECISION
        : CLOSED_SET_PLAIN_PRECISION;
    return fit.precision >= needed ? "redrawn" : null;
  }
  if (sprite.contrast >= RICH_CONTRAST) return fit.precision >= RICH_PRECISION ? "redrawn" : null;
  if (sprite.contrast >= PLAIN_CONTRAST) return fit.precision >= PLAIN_PRECISION ? "redrawn" : null;
  return null;
};

/** Ranking key. Both axes matter, so neither is allowed to dominate alone. */
export const fitStrength = (fit: Fit): number => fit.precision + fit.recall;

/**
 * How much weight a sprite's agreement carries. Featureless artwork agrees with
 * almost anything it is laid over, so the same precision from a detailed sprite is
 * far better evidence. Saturates, since past a point more detail does not make a
 * match more certain.
 */
const distinctiveness = (sprite: MatchSprite): number =>
  Math.min(1, sprite.contrast / RICH_CONTRAST);

/**
 * Ranking for competitive assignment, where sprites compete for slots and the
 * strongest reading wins.
 *
 * Certainty outranks everything, and it has to. Judged on precision and recall
 * alone, a redrawn match covering most of its slot outscores an exact one covering
 * a corner of it — so a small item agreeing on every single pixel was losing its
 * own slot to a loose reading of a different item and being reported missing while
 * sitting there at 100%. Four items on a reference workbench capture went that way.
 *
 * Below that, agreement is weighted by how much the sprite's detail is worth.
 * Adding precision to recall quietly favours bland, sprawling artwork: on a
 * reference slot a Prototype godstaff agreeing on 80% of its pixels lost to a
 * painting of contrast 16 that covered more of the slot, and the workbench read
 * the wrong item while still reporting the right number of items.
 *
 * Hue bias breaks ties between dark silhouettes that all clear TOLERANCE. Raw RGB
 * distance was not enough: a grey carving sat closer in absolute RGB to a green
 * scroll's median than the matching green sprite did, because the carving is
 * brighter. Comparing (G−R, G−B) keeps the green scroll ahead of the grey one.
 */
export const rankOf = (
  verdict: FitVerdict,
  fit: Fit,
  sprite: MatchSprite,
  slot?: SlotContent,
): number => {
  const base =
    (verdict === "exact" ? 10 : 0) +
    fit.precision * fit.recall * distinctiveness(sprite);
  // Extra terms are only for separating near-tied *exact* readings. Applying
  // them to redrawn matches re-opened the Prototype godstaff / inquisitor seal
  // confusion that distinctiveness was meant to settle.
  if (verdict !== "exact") return base;

  let colour = 0;
  if (slot && slot.count) {
    const slotGR = slot.meanG - slot.meanR;
    const slotGB = slot.meanG - slot.meanB;
    // Only trust hue when the slot itself is tinted. A neutral grey lump made the
    // green-bias term favour another grey carving over the correct curse tablet.
    const slotTint = Math.min(1, (Math.abs(slotGR) + Math.abs(slotGB)) / 8);
    if (slotTint > 0) {
      const spriteGR = sprite.meanG - sprite.meanR;
      const spriteGB = sprite.meanG - sprite.meanB;
      const hueGap = Math.abs(spriteGR - slotGR) + Math.abs(spriteGB - slotGB);
      colour = (1 - Math.min(1, hueGap / 40)) * slotTint;
    }
  }
  // Prefer the exact reading that actually covers the icon. Sparse sprites can
  // hit 98%+ on a corner of a different item; without recall in the tie-break
  // they steal the cell from the real exact match (decorative amphora phantoms).
  return base + fit.precision + fit.recall + colour;
};
