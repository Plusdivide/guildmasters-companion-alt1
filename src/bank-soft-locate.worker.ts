/// <reference lib="webworker" />
import {
  softLocateSprite,
  unpackSprite,
  type SoftLocateScreen,
} from "./bank-soft-locate-core.ts";

export type SoftLocateWorkerRequest = {
  width: number;
  height: number;
  /** RGBA screen buffer (copy owned by this worker for the job). */
  screen: ArrayBuffer;
  sprites: {
    index: number;
    width: number;
    height: number;
    count: number;
    buffers: ArrayBuffer[];
  }[];
};

export type SoftLocateWorkerResponse = {
  hits: ({ index: number; centreX: number; centreY: number } | { index: number })[];
};

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<SoftLocateWorkerRequest>) => {
  const { width, height, screen, sprites } = event.data;
  const pixels: SoftLocateScreen = {
    width,
    height,
    data: new Uint8ClampedArray(screen),
  };
  const hits: SoftLocateWorkerResponse["hits"] = [];
  for (const entry of sprites) {
    const sprite = unpackSprite(entry.width, entry.height, entry.count, entry.buffers);
    const hit = softLocateSprite(pixels, sprite);
    hits.push(
      hit
        ? { index: entry.index, centreX: hit.centreX, centreY: hit.centreY }
        : { index: entry.index },
    );
  }
  ctx.postMessage({ hits } satisfies SoftLocateWorkerResponse);
};
