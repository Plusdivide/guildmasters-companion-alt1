/**
 * Bench workbench soft-locate: sequential vs parallel, and claim parity.
 *
 *   node --experimental-strip-types scripts/diag/bench-workbench-soft-locate.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../lib/png.mjs";
import { prepareSprite } from "../../src/matcher.ts";
import { matchWorkbenchStorageStitch } from "../../src/workbench-stitch-match.ts";
import { softLocateAllSprites } from "../../src/workbench-soft-locate.ts";

const root = path.resolve(import.meta.dirname, "../..");
const refFull = path.join(
  "W:/005 Dev/03 Alt1 Custom Apps/Arch reference",
  "Workbench-Storage_Capture.PNG",
);
const matchRoot = path.join(root, "public/sprites-framed");

const toImage = ({ width, height, data }) => ({
  width,
  height,
  data: new Uint8ClampedArray(data),
});

const full = toImage(decodePng(fs.readFileSync(refFull)));
const x0 = 29;
const y0 = 54;
const w = 212;
const h = 398;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const si = ((y0 + y) * full.width + (x0 + x)) * 4;
    const di = (y * w + x) * 4;
    data.set(full.data.subarray(si, si + 4), di);
  }
}
const screen = { width: w, height: h, data };

const targets = [];
const sprites = [];
for (const file of fs.readdirSync(matchRoot).filter((f) => f.endsWith(".png") && f.includes("-damaged"))) {
  const image = toImage(decodePng(fs.readFileSync(path.join(matchRoot, file))));
  const fit = prepareSprite(image);
  if (!fit) continue;
  const name = file.replace(/\.png$/, "");
  targets.push({ name, fit, image, ref: name });
  sprites.push(fit);
}

const fingerprint = (matched) =>
  matched.claims
    .map((c) => `${c.row},${c.column}:${c.target.name ?? c.target.ref}:${c.exact ? "e" : "r"}`)
    .sort()
    .join("|");

console.log(`sprites ${sprites.length}  screen ${screen.width}×${screen.height}`);

const t0 = performance.now();
const softSeq = await softLocateAllSprites(screen, sprites, undefined, { parallel: false });
const softSeqMs = performance.now() - t0;

const t1 = performance.now();
const softPar = await softLocateAllSprites(screen, sprites, undefined, { parallel: true });
const softParMs = performance.now() - t1;

console.log(
  `soft-locate only: sequential ${softSeqMs.toFixed(0)}ms (${softSeq.length} anchors) · parallel ${softParMs.toFixed(0)}ms (${softPar.length} anchors)`,
);

const anchorKey = (list) =>
  list.map((a) => `${a.centreX.toFixed(2)},${a.centreY.toFixed(2)}`).join("|");
console.log(`anchors identical: ${anchorKey(softSeq) === anchorKey(softPar)}`);

const t2 = performance.now();
const seq = await matchWorkbenchStorageStitch(screen, targets, undefined, {
  parallelSoftLocate: false,
});
const seqMs = performance.now() - t2;

const t3 = performance.now();
const par = await matchWorkbenchStorageStitch(screen, targets, undefined, {
  parallelSoftLocate: true,
});
const parMs = performance.now() - t3;

const same = fingerprint(seq) === fingerprint(par);
console.log(
  `full match: sequential ${seqMs.toFixed(0)}ms (${seq.claims.length} claims) · parallel ${parMs.toFixed(0)}ms (${par.claims.length} claims)`,
);
console.log(`claims fingerprint identical: ${same}`);
console.log(
  `saved soft-locate ~${Math.max(0, softSeqMs - softParMs).toFixed(0)}ms · full ~${Math.max(0, seqMs - parMs).toFixed(0)}ms`,
);
if (!same) process.exitCode = 1;
