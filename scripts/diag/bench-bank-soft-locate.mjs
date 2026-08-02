/**
 * Bench bank soft-locate: sequential vs parallel, and claim parity.
 *
 *   node --experimental-strip-types scripts/diag/bench-bank-soft-locate.mjs
 */
import fs from "node:fs";
import { decodePng } from "../lib/png.mjs";
import { prepareSprite } from "../../src/matcher.ts";
import { matchBankStorageStitch } from "../../src/bank-stitch-match.ts";
import { softLocateAllSprites } from "../../src/bank-soft-locate.ts";

const root = new URL("../..", import.meta.url);
const capturePath =
  process.argv[2] ??
  "W:/005 Dev/03 Alt1 Custom Apps/Arch reference/storage-stitch_Bank.png";
const matchRoot = new URL("../../public/sprites-framed/", import.meta.url);

const toImage = ({ width, height, data }) => ({
  width,
  height,
  data: new Uint8ClampedArray(data),
});

const skip = new Set([
  "black-mushroom-ink",
  "grapes",
  "soft-clay",
  "bronze-bar",
  "silver-bar",
  "diamond",
  "ruby",
  "sapphire",
  "emerald",
  "dragonstone",
  "molten-glass",
  "rope",
  "clockwork",
  "phoenix-feather",
  "death-rune",
  "white-candle",
  "weapon-poison-3",
]);

const screen = toImage(decodePng(fs.readFileSync(capturePath)));
const targets = [];
for (const file of fs.readdirSync(matchRoot).filter((f) => f.endsWith(".png"))) {
  if (file.startsWith("mat-")) {
    if (skip.has(file.slice(4, -4))) continue;
  } else if (!(file.includes("-damaged") || file.includes("-restored"))) {
    continue;
  }
  const buf = decodePng(fs.readFileSync(new URL(file, matchRoot)));
  const image = toImage(buf);
  const fit = prepareSprite(image);
  if (fit) targets.push({ name: file.slice(0, -4), fit, image, ref: file });
}

const blankSprites = [];
for (const file of [
  "tetracompass-piece-left.png",
  "tetracompass-piece-right.png",
  "tetracompass-piece-dial.png",
  "tetracompass-piece-needle.png",
]) {
  const full = new URL(file, matchRoot);
  if (!fs.existsSync(full)) continue;
  const fit = prepareSprite(toImage(decodePng(fs.readFileSync(full))));
  if (fit) blankSprites.push(fit);
}

const sprites = targets.map((t) => t.fit);

const fingerprint = (result) =>
  JSON.stringify({
    cols: result.columns.map((v) => +v.toFixed(4)),
    rows: result.rows.map((v) => +v.toFixed(4)),
    claims: result.claims.map((c) => ({
      name: c.target.name ?? targets.find((t) => t === c.target)?.name,
      x: +c.centreX.toFixed(4),
      y: +c.centreY.toFixed(4),
      exact: c.exact,
      p: +c.precision.toFixed(6),
    })),
    blanks: result.blanks.map((b) => [+b.x.toFixed(4), +b.y.toFixed(4)]),
    unresolved: result.unresolved.map((u) => [
      +u.x.toFixed(4),
      +u.y.toFixed(4),
      u.guess?.name ?? targets.find((t) => t === u.guess)?.name ?? null,
      +u.precision.toFixed(6),
      +u.recall.toFixed(6),
    ]),
  });

console.log(`sprites ${sprites.length}  capture ${screen.width}x${screen.height}`);

const tSoftSeq0 = performance.now();
const softSeq = await softLocateAllSprites(screen, sprites, undefined, {
  parallel: false,
});
const softSeqMs = performance.now() - tSoftSeq0;

const tSoftPar0 = performance.now();
const softPar = await softLocateAllSprites(screen, sprites, undefined, {
  parallel: true,
});
const softParMs = performance.now() - tSoftPar0;

const softSame =
  softSeq.length === softPar.length &&
  softSeq.every(
    (a, i) =>
      Math.abs(a.centreX - softPar[i].centreX) < 1e-9 &&
      Math.abs(a.centreY - softPar[i].centreY) < 1e-9,
  );

console.log(
  `soft-locate sequential ${softSeqMs.toFixed(0)}ms  parallel ${softParMs.toFixed(0)}ms  saved ${(softSeqMs - softParMs).toFixed(0)}ms (${((1 - softParMs / softSeqMs) * 100).toFixed(0)}%)  anchors ${softSeq.length}  identical ${softSame}`,
);

const tSeq0 = performance.now();
const seq = await matchBankStorageStitch(screen, targets, undefined, {
  blankSprites,
  parallelSoftLocate: false,
});
const seqMs = performance.now() - tSeq0;

const tPar0 = performance.now();
const par = await matchBankStorageStitch(screen, targets, undefined, {
  blankSprites,
  parallelSoftLocate: true,
});
const parMs = performance.now() - tPar0;

const same = fingerprint(seq) === fingerprint(par);
console.log(
  `full match sequential ${seqMs.toFixed(0)}ms  parallel ${parMs.toFixed(0)}ms  saved ${(seqMs - parMs).toFixed(0)}ms (${((1 - parMs / seqMs) * 100).toFixed(0)}%)`,
);
console.log(
  `claims ${seq.claims.length} vs ${par.claims.length}  unresolved ${seq.unresolved.length} vs ${par.unresolved.length}  fingerprint identical ${same}`,
);
if (!same) {
  console.error("PARITY FAILURE");
  process.exitCode = 1;
}
