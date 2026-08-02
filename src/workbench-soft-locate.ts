/**
 * Soft-locate every workbench sprite. Parallelises across workers when available;
 * falls back to the same sequential loop (bit-identical per sprite).
 * Workbench-only — do not import from bank or material-storage.
 */
import {
  packSprite,
  softLocateSprite,
  type WorkbenchSoftLocateHit,
  type WorkbenchSoftLocateScreen,
  type WorkbenchSoftLocateSprite,
} from "./workbench-soft-locate-core.ts";
import type {
  WorkbenchSoftLocateWorkerRequest,
  WorkbenchSoftLocateWorkerResponse,
} from "./workbench-soft-locate.worker.ts";

const workerPoolSize = (): number => {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(8, cores));
};

const screenBuffer = (screen: WorkbenchSoftLocateScreen): ArrayBuffer => {
  const view = screen.data;
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
};

const createBrowserWorker = (): Worker | null => {
  try {
    return new Worker(new URL("./workbench-soft-locate.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return null;
  }
};

const softLocateSequential = (
  screen: WorkbenchSoftLocateScreen,
  sprites: WorkbenchSoftLocateSprite[],
  onProgress?: (checked: number, total: number) => void,
): WorkbenchSoftLocateHit[] => {
  const anchors: WorkbenchSoftLocateHit[] = [];
  for (let index = 0; index < sprites.length; index += 1) {
    const hit = softLocateSprite(screen, sprites[index]);
    if (hit) anchors.push(hit);
    if (index % 20 === 0) onProgress?.(index, sprites.length);
  }
  onProgress?.(sprites.length, sprites.length);
  return anchors;
};

const runBatchOnWorker = (
  worker: Worker,
  screen: WorkbenchSoftLocateScreen,
  sprites: WorkbenchSoftLocateSprite[],
  indexBase: number,
): Promise<WorkbenchSoftLocateWorkerResponse["hits"]> => {
  const screenCopy = screen.data.slice();
  const screenAb = screenBuffer({
    width: screen.width,
    height: screen.height,
    data: screenCopy,
  });
  const packed = sprites.map((sprite, offset) => {
    const buffers = packSprite(sprite);
    return {
      index: indexBase + offset,
      width: sprite.width,
      height: sprite.height,
      count: sprite.count,
      buffers,
    };
  });
  const request: WorkbenchSoftLocateWorkerRequest = {
    width: screen.width,
    height: screen.height,
    screen: screenAb,
    sprites: packed,
  };
  const transfer: ArrayBuffer[] = [screenAb];
  for (const entry of packed) transfer.push(...entry.buffers);

  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkbenchSoftLocateWorkerResponse>) => {
      resolve(event.data.hits);
    };
    worker.onerror = (error) => reject(error);
    worker.postMessage(request, transfer);
  });
};

const softLocateParallelWorkers = async (
  screen: WorkbenchSoftLocateScreen,
  sprites: WorkbenchSoftLocateSprite[],
  onProgress?: (checked: number, total: number) => void,
): Promise<WorkbenchSoftLocateHit[] | null> => {
  const workers: Worker[] = [];
  const pool = Math.min(workerPoolSize(), sprites.length);
  for (let i = 0; i < pool; i += 1) {
    const worker = createBrowserWorker();
    if (!worker) {
      for (const open of workers) open.terminate();
      return null;
    }
    workers.push(worker);
  }

  const results: ({ centreX: number; centreY: number } | null)[] = Array.from(
    { length: sprites.length },
    () => null,
  );
  let completed = 0;

  try {
    const chunkSize = Math.ceil(sprites.length / workers.length);
    await Promise.all(
      workers.map(async (worker, workerIndex) => {
        const start = workerIndex * chunkSize;
        const end = Math.min(sprites.length, start + chunkSize);
        if (start >= end) return;
        const hits = await runBatchOnWorker(
          worker,
          screen,
          sprites.slice(start, end),
          start,
        );
        for (const hit of hits) {
          if ("centreX" in hit && "centreY" in hit) {
            results[hit.index] = {
              centreX: hit.centreX,
              centreY: hit.centreY,
            };
          }
          completed += 1;
          if (completed % 20 === 0 || completed === sprites.length) {
            onProgress?.(completed, sprites.length);
          }
        }
      }),
    );
  } catch {
    for (const worker of workers) worker.terminate();
    return null;
  }

  for (const worker of workers) worker.terminate();

  const anchors: WorkbenchSoftLocateHit[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const hit = results[index];
    if (hit) anchors.push(hit);
  }
  onProgress?.(sprites.length, sprites.length);
  return anchors;
};

const softLocateParallelNode = async (
  screen: WorkbenchSoftLocateScreen,
  sprites: WorkbenchSoftLocateSprite[],
  onProgress?: (checked: number, total: number) => void,
): Promise<WorkbenchSoftLocateHit[] | null> => {
  try {
    const { Worker } = await import("node:worker_threads");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const os = await import("node:os");
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "workbench-soft-locate.node-worker.ts",
    );

    const cores = os.availableParallelism?.() ?? os.cpus().length ?? 4;
    const pool = Math.min(Math.max(1, Math.min(8, cores)), sprites.length);
    const results: ({ centreX: number; centreY: number } | null)[] = Array.from(
      { length: sprites.length },
      () => null,
    );
    let completed = 0;
    const chunkSize = Math.ceil(sprites.length / pool);

    await Promise.all(
      Array.from({ length: pool }, (_, workerIndex) => {
        const start = workerIndex * chunkSize;
        const end = Math.min(sprites.length, start + chunkSize);
        if (start >= end) return Promise.resolve();

        const batch = sprites.slice(start, end).map((sprite, offset) => ({
          index: start + offset,
          width: sprite.width,
          height: sprite.height,
          count: sprite.count,
          xs: Array.from(sprite.xs),
          ys: Array.from(sprite.ys),
          rs: Array.from(sprite.rs),
          gs: Array.from(sprite.gs),
          bs: Array.from(sprite.bs),
        }));

        return new Promise<void>((resolve, reject) => {
          const worker = new Worker(workerPath, {
            workerData: {
              width: screen.width,
              height: screen.height,
              screen: Array.from(screen.data),
              sprites: batch,
            },
            execArgv: ["--experimental-strip-types"],
          });
          worker.on("message", (hits: WorkbenchSoftLocateWorkerResponse["hits"]) => {
            for (const hit of hits) {
              if ("centreX" in hit && "centreY" in hit) {
                results[hit.index] = {
                  centreX: hit.centreX,
                  centreY: hit.centreY,
                };
              }
              completed += 1;
              if (completed % 20 === 0 || completed === sprites.length) {
                onProgress?.(completed, sprites.length);
              }
            }
            void worker.terminate();
            resolve();
          });
          worker.on("error", reject);
        });
      }),
    );

    const anchors: WorkbenchSoftLocateHit[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const hit = results[index];
      if (hit) anchors.push(hit);
    }
    onProgress?.(sprites.length, sprites.length);
    return anchors;
  } catch {
    return null;
  }
};

export type WorkbenchSoftLocateOptions = {
  /** Force sequential (for benches / parity checks). Default: parallel when possible. */
  parallel?: boolean;
};

export const softLocateAllSprites = async (
  screen: WorkbenchSoftLocateScreen,
  sprites: WorkbenchSoftLocateSprite[],
  onProgress?: (checked: number, total: number) => void,
  options: WorkbenchSoftLocateOptions = {},
): Promise<WorkbenchSoftLocateHit[]> => {
  const wantParallel = options.parallel !== false && sprites.length >= 8;
  if (wantParallel) {
    if (typeof Worker !== "undefined") {
      const parallel = await softLocateParallelWorkers(screen, sprites, onProgress);
      if (parallel) return parallel;
    }
    if (typeof process !== "undefined" && process.versions?.node) {
      const parallel = await softLocateParallelNode(screen, sprites, onProgress);
      if (parallel) return parallel;
    }
  }
  return softLocateSequential(screen, sprites, onProgress);
};
