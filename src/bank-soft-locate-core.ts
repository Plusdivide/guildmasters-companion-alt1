/**
 * Pure soft-locate for one sprite on a bank stitch still.
 * Shared by the main thread and workers so parallel/serial stay bit-identical.
 */

export type SoftLocateSprite = {
  xs: Int16Array;
  ys: Int16Array;
  rs: Uint8Array;
  gs: Uint8Array;
  bs: Uint8Array;
  width: number;
  height: number;
  count: number;
};

export type SoftLocateScreen = {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
};

export type SoftLocateHit = {
  centreX: number;
  centreY: number;
};

const TOLERANCE = 30;
const TRUST = 0.9;

export const precisionAtSprite = (
  screen: SoftLocateScreen,
  sprite: SoftLocateSprite,
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

/** Best soft-locate hit for one sprite, or null if below TRUST. */
export const softLocateSprite = (
  screen: SoftLocateScreen,
  sprite: SoftLocateSprite,
): SoftLocateHit | null => {
  const seeds: { x: number; y: number; p: number }[] = [];
  for (let y = 0; y + sprite.height < screen.height; y += 2) {
    for (let x = 0; x + sprite.width < screen.width; x += 2) {
      const p = precisionAtSprite(screen, sprite, x, y, 7);
      if (p >= 0.8) seeds.push({ x, y, p });
    }
  }
  seeds.sort((a, b) => b.p - a.p);
  let best = { x: 0, y: 0, p: -1 };
  for (const seed of seeds.slice(0, 80)) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const p = precisionAtSprite(screen, sprite, seed.x + dx, seed.y + dy, 1);
        if (p > best.p) best = { x: seed.x + dx, y: seed.y + dy, p };
      }
    }
  }
  if (best.p < TRUST) return null;
  return {
    centreX: best.x + sprite.width / 2,
    centreY: best.y + sprite.height / 2,
  };
};

export const packSprite = (sprite: SoftLocateSprite): ArrayBuffer[] => [
  sprite.xs.buffer.slice(
    sprite.xs.byteOffset,
    sprite.xs.byteOffset + sprite.xs.byteLength,
  ) as ArrayBuffer,
  sprite.ys.buffer.slice(
    sprite.ys.byteOffset,
    sprite.ys.byteOffset + sprite.ys.byteLength,
  ) as ArrayBuffer,
  sprite.rs.buffer.slice(
    sprite.rs.byteOffset,
    sprite.rs.byteOffset + sprite.rs.byteLength,
  ) as ArrayBuffer,
  sprite.gs.buffer.slice(
    sprite.gs.byteOffset,
    sprite.gs.byteOffset + sprite.gs.byteLength,
  ) as ArrayBuffer,
  sprite.bs.buffer.slice(
    sprite.bs.byteOffset,
    sprite.bs.byteOffset + sprite.bs.byteLength,
  ) as ArrayBuffer,
];

export const unpackSprite = (
  width: number,
  height: number,
  count: number,
  buffers: ArrayBuffer[],
): SoftLocateSprite => ({
  width,
  height,
  count,
  xs: new Int16Array(buffers[0]),
  ys: new Int16Array(buffers[1]),
  rs: new Uint8Array(buffers[2]),
  gs: new Uint8Array(buffers[3]),
  bs: new Uint8Array(buffers[4]),
});
