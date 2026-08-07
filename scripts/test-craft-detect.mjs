/**
 * Offline craft-popup detection (artefact name + N/M progress).
 *
 *   npm run test:craft
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { createWorker } from "tesseract.js";
import { decodePng } from "./lib/png.mjs";
import {
  cropImage,
  nearestScale,
  readCraftPopup,
} from "../src/craft-detect.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const fixtures = join(root, "fixtures", "restore");

const encodePng = (img) => {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data).copy(
      raw,
      y * (w * 4 + 1) + 1,
      y * w * 4,
      (y + 1) * w * 4,
    );
  }
  const compressed = zlib.deflateSync(raw);
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
      c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, payload) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length);
    const typeB = Buffer.from(type);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc(Buffer.concat([typeB, payload])));
    return Buffer.concat([len, typeB, payload, crcB]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const loadPng = (name) => {
  const decoded = decodePng(readFileSync(join(fixtures, name)));
  return {
    data: decoded.data,
    width: decoded.width,
    height: decoded.height,
  };
};

const archaeology = JSON.parse(
  readFileSync(join(root, "src", "data", "archaeology.json"), "utf8"),
);
const artefactNames = archaeology.artefacts.map((a) => a.name);

const normalize = (text) =>
  String(text)
    .toLowerCase()
    .replace(/\(damaged\)/gi, "")
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const matchArtefact = (text) => {
  const needle = normalize(text);
  if (needle.length < 4) return null;
  let best = null;
  let bestLen = 0;
  for (const name of artefactNames) {
    const n = normalize(name);
    if (needle.includes(n) && n.length > bestLen) {
      best = name;
      bestLen = n.length;
    }
  }
  return best;
};

const readNameTesseract = async (image, band) => {
  if (!band) return null;
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 /'-",
    tessedit_pageseg_mode: "7",
  });
  try {
    const crop = cropImage(image, band);
    for (const scale of [2, 3, 4]) {
      const {
        data: { text },
      } = await worker.recognize(encodePng(nearestScale(crop, scale)));
      const raw = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const hit = matchArtefact(raw);
      if (hit) return { raw, name: hit };
    }
  } finally {
    await worker.terminate();
  }
  return null;
};

const cases = [
  {
    name: "craft-venator-done.png",
    expectProgress: "1/1",
    expectArtefact: "Venator dagger",
  },
];

let failed = 0;
for (const test of cases) {
  const image = loadPng(test.name);
  const { progress, nameBand } = readCraftPopup(image);
  const nameHit = await readNameTesseract(image, nameBand);

  const progressOk = progress?.raw === test.expectProgress;
  const nameOk = nameHit?.name === test.expectArtefact;
  const ok = progressOk && nameOk;
  if (!ok) failed += 1;

  console.log(
    `${ok ? "PASS" : "FAIL"} ${test.name} (${image.width}x${image.height})`,
  );
  console.log(
    `  progress: ${progress ? progress.raw : "MISS"} (expect ${test.expectProgress})` +
      (progress ? ` bar@${progress.bar.x},${progress.bar.y}` : ""),
  );
  console.log(
    `  artefact: ${nameHit ? `${nameHit.name} ← "${nameHit.raw}"` : "MISS"}` +
      (nameBand ? ` band@${nameBand.x},${nameBand.y}` : " (no name band)"),
  );
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll craft fixtures detected.");
