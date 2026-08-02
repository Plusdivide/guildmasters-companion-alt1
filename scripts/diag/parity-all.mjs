/**
 * Offline parity for all three stitch matchers (live path modules).
 *   node --experimental-strip-types scripts/diag/parity-all.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../lib/png.mjs";
import { prepareSprite } from "../../src/matcher.ts";
import { matchBankStorageStitch } from "../../src/bank-stitch-match.ts";
import { matchMaterialStorageStitch } from "../../src/material-stitch-match.ts";
import { matchWorkbenchStorageStitch } from "../../src/workbench-stitch-match.ts";

const root = path.resolve(import.meta.dirname, "../..");
const ref = "W:/005 Dev/03 Alt1 Custom Apps/Arch reference";
const matchRoot = path.join(root, "public/sprites-framed");

const toImage = ({ width, height, data }) => ({
  width,
  height,
  data: new Uint8ClampedArray(data),
});
const loadPng = (file) => toImage(decodePng(fs.readFileSync(file)));

const shopSkip = new Set([
  "black-mushroom-ink", "grapes", "soft-clay", "bronze-bar", "silver-bar",
  "diamond", "ruby", "sapphire", "emerald", "dragonstone", "molten-glass",
  "rope", "clockwork", "phoenix-feather", "death-rune", "white-candle",
  "weapon-poison-3",
]);

const loadTargets = (predicate) => {
  const targets = [];
  for (const file of fs.readdirSync(matchRoot).filter((f) => f.endsWith(".png") && predicate(f))) {
    const image = loadPng(path.join(matchRoot, file));
    const fit = prepareSprite(image);
    if (fit) targets.push({ name: file.replace(/\.png$/, ""), fit, image, ref: file });
  }
  return targets;
};

const nameOf = (targets, claim) => {
  const hit = targets.find((t) => t === claim.target || t.ref === claim.target.ref);
  return hit?.name ?? "?";
};

/* BANK */
{
  const screen = loadPng(path.join(ref, "storage-stitch_Bank.png"));
  const targets = loadTargets(
    (file) =>
      (file.startsWith("mat-") && !shopSkip.has(file.replace(/^mat-/, "").replace(/\.png$/, ""))) ||
      file.includes("-damaged") ||
      file.includes("-restored"),
  );
  const blankSprites = [];
  for (const file of [
    "tetracompass-piece-left.png",
    "tetracompass-piece-right.png",
    "tetracompass-piece-dial.png",
    "tetracompass-piece-needle.png",
  ]) {
    const full = path.join(matchRoot, file);
    if (!fs.existsSync(full)) continue;
    const fit = prepareSprite(loadPng(full));
    if (fit) blankSprites.push(fit);
  }
  const matched = await matchBankStorageStitch(screen, targets, undefined, { blankSprites });
  const ok = matched.claims.length === 56;
  console.log(
    `BANK: claims ${matched.claims.length} (expect 56) · unresolved ${matched.unresolved.length} · blanks ${matched.blanks.length} ${ok ? "OK" : "FAIL"}`,
  );
}

/* MATERIALS */
{
  const screen = loadPng(path.join(ref, "storage-stitch_Materials.png"));
  const targets = loadTargets((file) => file.startsWith("mat-"));
  const padlock = prepareSprite(loadPng(path.join(root, "public/ui/slot-padlock.png")));
  const matched = await matchMaterialStorageStitch(screen, targets, padlock);
  const ok = matched.claims.length === 40 && matched.unresolved.length === 0;
  console.log(
    `MATERIALS: claims ${matched.claims.length} (expect 40) · unresolved ${matched.unresolved.length} (expect 0) ${ok ? "OK" : "FAIL"}`,
  );
}

/* WORKBENCH — crop used by rebuild-workbench-canvas.mjs */
{
  const full = loadPng(path.join(ref, "Workbench-Storage_Capture.PNG"));
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
  const targets = loadTargets((file) => file.includes("-damaged"));
  const matched = await matchWorkbenchStorageStitch(screen, targets);
  const names = matched.claims.map((c) => nameOf(targets, c)).sort();

  const audit = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/diag/workbench-audit.json"), "utf8"),
  );
  const expected = audit.cells
    .filter((c) => c.verdict === "exact" || c.verdict === "redrawn")
    .map((c) => c.name)
    .sort();
  const got = new Set(names);
  const missing = expected.filter((n) => !got.has(n));
  const extra = names.filter((n) => !expected.includes(n));
  const ok = missing.length === 0 && matched.columns.length === 5;
  console.log(
    `WORKBENCH: claims ${matched.claims.length} · cols ${matched.columns.length} · unresolved ${matched.unresolved.length}`,
  );
  console.log(
    `  vs audit.json expected ${expected.length}: missing ${missing.length} · extra ${extra.length} ${ok ? "OK" : "CHECK"}`,
  );
  if (missing.length) console.log("  missing:", missing.slice(0, 15).join(", "));
  if (extra.length) console.log("  extra:", extra.slice(0, 15).join(", "));
}
