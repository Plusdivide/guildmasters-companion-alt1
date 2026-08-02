// Composes public/sprites, the folder the scanner loads, from the staged wiki art
// in sprite-sources/wiki.
//
// The wiki drawings are the right artwork: measured against a lossless bank
// capture, most are pixel-identical to what the client draws. The item-db renders
// staged in sprite-sources/itemdb were tried and rejected — they carry a baked
// drop shadow the client does not draw, and stripping it costs artwork.
//
// The build does exactly two things, both about how the browser will decode the
// file rather than about the drawing:
//
//   1. Normalises to straight 8-bit RGBA. The wiki mixes palette+tRNS, RGB with a
//      transparent colour key, and full RGBA. Emitting one form keeps every
//      consumer honest about which pixels are transparent.
//   2. Drops iCCP/gAMA/cHRM/sRGB. Those make the browser colour-manage the image,
//      so the pixels the app compares stop being the pixels in the file and stop
//      matching the client. Alt1 ships its own loader to strip them for the same
//      reason. Around 50 of the wiki files carry them.
//
// Nothing here edits artwork. If a sprite does not match the client, that is a
// data problem to fix in sprite-sources, not something to paper over here.
//
// Run `npm run build-sprites` after `npm run sync-sprites`.

import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./lib/png.mjs";

const WIKI = "sprite-sources/wiki";
const TARGET = "public/sprites";

const spriteMap = JSON.parse(fs.readFileSync("src/data/sprites.json", "utf8"));

const wanted = [];
for (const entry of Object.values(spriteMap.artefacts ?? {})) {
  if (entry.damaged) wanted.push(entry.damaged);
  if (entry.restored) wanted.push(entry.restored);
}
for (const file of Object.values(spriteMap.materials ?? {})) wanted.push(file);

const colourChunks = new Set(["iCCP", "gAMA", "cHRM", "sRGB"]);
const chunkNames = (buffer) => {
  const names = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const name = buffer.toString("ascii", offset + 4, offset + 8);
    names.push(name);
    if (name === "IEND") break;
    offset += 12 + length;
  }
  return names;
};

fs.mkdirSync(TARGET, { recursive: true });

const summary = { written: 0, colourManaged: 0, noAlpha: 0, missing: [] };

for (const file of wanted) {
  const full = path.join(WIKI, file);
  if (!fs.existsSync(full)) {
    summary.missing.push(file);
    continue;
  }
  const buffer = fs.readFileSync(full);
  if (chunkNames(buffer).some((name) => colourChunks.has(name))) summary.colourManaged += 1;

  const image = decodePng(buffer);
  let transparent = 0;
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] === 0) transparent += 1;
  }
  // An icon with no transparency at all is suspicious: it means the drawing fills
  // the whole canvas, which no inventory icon does. Worth knowing about rather
  // than silently matching a rectangle of background.
  if (transparent === 0) summary.noAlpha += 1;

  fs.writeFileSync(path.join(TARGET, file), encodePng(image));
  summary.written += 1;
}

console.log(`wrote ${TARGET}`);
console.log("  sprites written:                        ", summary.written);
console.log("  had colour-management chunks stripped:  ", summary.colourManaged);
console.log("  with no transparent pixel at all:       ", summary.noAlpha);
console.log("  missing from wiki source:               ", summary.missing.length, summary.missing.slice(0, 8));
