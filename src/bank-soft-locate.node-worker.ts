/**
 * Node worker_threads entry for bank soft-locate (parity with browser worker).
 */
import { parentPort, workerData } from "node:worker_threads";
import { softLocateSprite } from "./bank-soft-locate-core.ts";

if (!parentPort) throw new Error("soft-locate node worker needs parentPort");

const { width, height, screen, sprites } = workerData as {
  width: number;
  height: number;
  screen: number[];
  sprites: {
    index: number;
    width: number;
    height: number;
    count: number;
    xs: number[];
    ys: number[];
    rs: number[];
    gs: number[];
    bs: number[];
  }[];
};

const pixels = {
  width,
  height,
  data: Uint8ClampedArray.from(screen),
};

const hits: ({ index: number; centreX: number; centreY: number } | { index: number })[] =
  [];
for (const entry of sprites) {
  const sprite = {
    width: entry.width,
    height: entry.height,
    count: entry.count,
    xs: Int16Array.from(entry.xs),
    ys: Int16Array.from(entry.ys),
    rs: Uint8Array.from(entry.rs),
    gs: Uint8Array.from(entry.gs),
    bs: Uint8Array.from(entry.bs),
  };
  const hit = softLocateSprite(pixels, sprite);
  hits.push(
    hit
      ? { index: entry.index, centreX: hit.centreX, centreY: hit.centreY }
      : { index: entry.index },
  );
}

parentPort.postMessage(hits);
