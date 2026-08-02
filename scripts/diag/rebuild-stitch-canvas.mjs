/**
 * Offline workbench audit of a storage stitch → annotated PNG + counts.
 * Matching is the live module (src/workbench-stitch-match.ts) — one implementation.
 *
 *   node --experimental-strip-types scripts/diag/rebuild-stitch-canvas.mjs [stitch.png]
 *
 * Default: Arch reference workbench left-pane crop (same as parity-all).
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "../lib/png.mjs";
import { prepareSprite } from "../../src/matcher.ts";
import { matchWorkbenchStorageStitch } from "../../src/workbench-stitch-match.ts";

const root = path.resolve(import.meta.dirname, "../..");
const refFull = path.join(
  "W:/005 Dev/03 Alt1 Custom Apps/Arch reference",
  "Workbench-Storage_Capture.PNG",
);
const spriteRoot = path.join(root, "public/sprites");
const framedRoot = path.join(root, "public/sprites-framed");
const matchRoot = fs.existsSync(framedRoot) ? framedRoot : spriteRoot;
const auditOut = path.join(root, "scripts/diag/audit-workbench.png");

const toImage = ({ width, height, data }) => ({
  width,
  height,
  data: new Uint8ClampedArray(data),
});

const loadCroppedReference = () => {
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
  return { width: w, height: h, data };
};

const capturePath = process.argv[2];
const screen = capturePath
  ? toImage(decodePng(fs.readFileSync(capturePath)))
  : loadCroppedReference();

const targets = [];
for (const file of fs.readdirSync(matchRoot).filter((f) => f.endsWith(".png") && f.includes("-damaged"))) {
  const image = toImage(decodePng(fs.readFileSync(path.join(matchRoot, file))));
  const fit = prepareSprite(image);
  const name = file.replace(/\.png$/, "");
  if (fit) targets.push({ name, fit, image, ref: name });
}
console.log(
  `capture ${screen.width}x${screen.height}   sprites ${targets.length}  (${path.basename(matchRoot)})`,
);

const matched = await matchWorkbenchStorageStitch(screen, targets);
const SLOT = matched.slotSize;
const claimed = matched.claims;
const missed = matched.unresolved;
const exact = claimed.filter((e) => e.exact).length;

console.log(
  `CLAIMED ${claimed.length} of ${claimed.length + missed.length} occupied  (exact ${exact}, redrawn ${claimed.length - exact})`,
);
console.log(`unclaimed: ${missed.length}`);
console.log(
  `grid ${matched.columns.length} cols × ${matched.rows.length} rows  slot ${SLOT}`,
);

const out = {
  width: screen.width,
  height: screen.height,
  data: new Uint8ClampedArray(screen.data),
};
const paint = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
  const i = (y * out.width + x) * 4;
  out.data[i] = r;
  out.data[i + 1] = g;
  out.data[i + 2] = b;
  out.data[i + 3] = 255;
};
const box = (cx, cy, color) => {
  const half = Math.floor(SLOT / 2);
  const x0 = Math.round(cx - half);
  const y0 = Math.round(cy - half);
  for (let t = 0; t < SLOT; t += 1) {
    paint(x0 + t, y0, ...color);
    paint(x0 + t, y0 + SLOT - 1, ...color);
    paint(x0, y0 + t, ...color);
    paint(x0 + SLOT - 1, y0 + t, ...color);
  }
};
for (const e of claimed) box(e.centreX, e.centreY, [40, 200, 80]);
for (const cell of missed) box(cell.x, cell.y, [220, 50, 50]);
fs.writeFileSync(auditOut, encodePng(out));
console.log("wrote", auditOut);
console.log("matcher: src/workbench-stitch-match.ts");
