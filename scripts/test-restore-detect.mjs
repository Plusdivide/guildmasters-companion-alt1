/**
 * Offline RESTORATION detection — bank-style title only (same as app).
 *
 *   npm run test:restore
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "./lib/png.mjs";
import {
  locateRestorationInImage,
  signatureFrom,
} from "../src/restore-detect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const loadPng = (rel) => {
  const decoded = decodePng(readFileSync(join(root, rel)));
  return {
    data: decoded.data,
    width: decoded.width,
    height: decoded.height,
  };
};

const titleRef = loadPng("public/ui/title-restoration.png");
const signature = signatureFrom(titleRef);
console.log(
  `title ref ${titleRef.width}x${titleRef.height} → signature ${
    signature
      ? `${signature.width}x${signature.height} (${signature.points.length / 2} pts)`
      : "FAILED"
  }`,
);

const cases = [
  { file: "fixtures/restore/window-venator-dagger.png", expect: true },
  { file: "fixtures/restore/craft-venator-done.png", expect: true },
  { file: "fixtures/restore/lobby-false-positive.png", expect: false },
  { file: "fixtures/restore/live-venator-dagger-popup.png", expect: false },
];

let failed = 0;
for (const test of cases) {
  if (!existsSync(join(root, test.file))) {
    console.log(`SKIP ${test.file}`);
    continue;
  }
  const image = loadPng(test.file);
  const hit = locateRestorationInImage(image, signature);
  const ok = Boolean(hit) === test.expect;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${test.file} expect=${test.expect} → ${
      hit ? `signature @${hit.title.x},${hit.title.y}` : "MISS"
    }`,
  );
}

if (!signature) failed += 1;
if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll scored restore fixtures OK.");
