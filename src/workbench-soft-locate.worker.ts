/// <reference lib="webworker" />
/**
 * Browser worker for workbench soft-locate. Workbench-only.
 */
import {
  softLocateSprite,
  unpackSprite,
  type WorkbenchSoftLocateScreen,
} from "./workbench-soft-locate-core.ts";

export type WorkbenchSoftLocateWorkerRequest = {
  width: number;
  height: number;
  screen: ArrayBuffer;
  sprites: {
    index: number;
    width: number;
    height: number;
    count: number;
    buffers: ArrayBuffer[];
  }[];
};

export type WorkbenchSoftLocateWorkerResponse = {
  hits: ({ index: number; centreX: number; centreY: number } | { index: number })[];
};

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkbenchSoftLocateWorkerRequest>) => {
  const { width, height, screen, sprites } = event.data;
  const pixels: WorkbenchSoftLocateScreen = {
    width,
    height,
    data: new Uint8ClampedArray(screen),
  };
  const hits: WorkbenchSoftLocateWorkerResponse["hits"] = [];
  for (const entry of sprites) {
    const sprite = unpackSprite(entry.width, entry.height, entry.count, entry.buffers);
    const hit = softLocateSprite(pixels, sprite);
    hits.push(
      hit
        ? { index: entry.index, centreX: hit.centreX, centreY: hit.centreY }
        : { index: entry.index },
    );
  }
  ctx.postMessage({ hits } satisfies WorkbenchSoftLocateWorkerResponse);
};
