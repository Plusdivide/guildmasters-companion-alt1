// Builds a separate set of 32x32 scanner sprites:
//
//   wiki pixels + cache placement -> public/sprites-framed
//
// Neither source set is modified. The cache image is used only as a placement
// template; none of its pixels (including its baked drop shadow) are copied.
//
// Item-db/cache renders cast their shadow down and right. Their top and left
// opaque edges therefore still locate the artwork reliably, while a centre or
// bottom-edge alignment would be pulled by the shadow. The tightly cropped wiki
// artwork is placed at that top-left opaque edge inside a transparent 32x32 frame.
//
// Usage:
//   npm run build-framed-sprites
//   node scripts/build-framed-sprites.mjs [cacheDir] [outputDir]

import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./lib/png.mjs";

const WIKI = "sprite-sources/wiki";
const CACHE =
  process.argv[2] ?? "W:/005 Dev/rs3-sprite-extractor/out/sprites";
const TARGET = process.argv[3] ?? "public/sprites-framed";
const FRAME = 32;

const spriteMap = JSON.parse(fs.readFileSync("src/data/sprites.json", "utf8"));

const wanted = new Set();
for (const entry of Object.values(spriteMap.artefacts ?? {})) {
  if (entry.damaged) wanted.add(entry.damaged);
  if (entry.restored) wanted.add(entry.restored);
}
for (const file of Object.values(spriteMap.materials ?? {})) wanted.add(file);

const opaqueBounds = (image) => {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const frameWikiArt = (wiki, cache) => {
  const wikiBounds = opaqueBounds(wiki);
  const cacheBounds = opaqueBounds(cache);
  if (!wikiBounds || !cacheBounds) return null;

  // Top-left alignment deliberately ignores the cache render's down-right shadow.
  // Clamp only when the wiki drawing is larger than the cache's visible artwork;
  // this preserves every wiki pixel while remaining as close to the template
  // position as a 32x32 frame permits.
  const copyWidth = Math.min(wikiBounds.width, FRAME);
  const copyHeight = Math.min(wikiBounds.height, FRAME);
  const destX = clamp(cacheBounds.minX, 0, FRAME - copyWidth);
  const destY = clamp(cacheBounds.minY, 0, FRAME - copyHeight);
  const placementAdjusted =
    destX !== cacheBounds.minX || destY !== cacheBounds.minY;
  const artworkClipped =
    copyWidth !== wikiBounds.width || copyHeight !== wikiBounds.height;

  const output = {
    width: FRAME,
    height: FRAME,
    data: new Uint8Array(FRAME * FRAME * 4),
  };

  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) {
      const source =
        ((wikiBounds.minY + y) * wiki.width + wikiBounds.minX + x) * 4;
      const target = ((destY + y) * FRAME + destX + x) * 4;
      output.data[target] = wiki.data[source];
      output.data[target + 1] = wiki.data[source + 1];
      output.data[target + 2] = wiki.data[source + 2];
      output.data[target + 3] = wiki.data[source + 3];
    }
  }

  return {
    output,
    destX,
    destY,
    wikiBounds,
    cacheBounds,
    placementAdjusted,
    artworkClipped,
  };
};

fs.mkdirSync(TARGET, { recursive: true });

const summary = {
  written: 0,
  missingWiki: [],
  missingCache: [],
  empty: [],
  clipped: [],
  adjusted: [],
};

for (const file of [...wanted].sort()) {
  const wikiPath = path.join(WIKI, file);
  const cachePath = path.join(CACHE, file);
  if (!fs.existsSync(wikiPath)) {
    summary.missingWiki.push(file);
    continue;
  }
  if (!fs.existsSync(cachePath)) {
    summary.missingCache.push(file);
    continue;
  }

  const framed = frameWikiArt(
    decodePng(fs.readFileSync(wikiPath)),
    decodePng(fs.readFileSync(cachePath)),
  );
  if (!framed) {
    summary.empty.push(file);
    continue;
  }
  fs.writeFileSync(path.join(TARGET, file), encodePng(framed.output));
  summary.written += 1;
  if (framed.artworkClipped) {
    summary.clipped.push(
      `${file}: ${framed.wikiBounds.width}x${framed.wikiBounds.height} artwork`,
    );
  }
  if (framed.placementAdjusted) {
    summary.adjusted.push(
      `${file}: cache ${framed.cacheBounds.minX},${framed.cacheBounds.minY}` +
        ` -> fitted ${framed.destX},${framed.destY}`,
    );
  }
}

console.log(`wrote new framed set to ${TARGET}`);
console.log("  32x32 sprites written:       ", summary.written);
console.log("  originals modified:           0");
console.log("  missing wiki/cache:          ", summary.missingWiki.length, "/", summary.missingCache.length);
console.log("  empty/clipped to 32x32:      ", summary.empty.length, "/", summary.clipped.length);
console.log("  placements clamped to frame:", summary.adjusted.length);
if (summary.missingWiki.length) console.log("  missing wiki:", summary.missingWiki.slice(0, 8));
if (summary.missingCache.length) console.log("  missing cache:", summary.missingCache.slice(0, 8));
if (summary.empty.length) console.log("  empty:", summary.empty.slice(0, 8));
if (summary.clipped.length) console.log("  clipped:", summary.clipped.slice(0, 8));
if (summary.adjusted.length) console.log("  clamped:", summary.adjusted.slice(0, 8));
