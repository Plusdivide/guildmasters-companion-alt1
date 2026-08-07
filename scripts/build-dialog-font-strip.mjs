/**
 * Chop dig-popup dialogue glyphs from Arch reference screenshots and assemble
 * a partial Alt1-style white-on-black strip (red width marks on the bottom row).
 *
 *   node scripts/build-dialog-font-strip.mjs
 *   node scripts/build-dialog-font-strip.mjs --only=t
 *   node scripts/build-dialog-font-strip.mjs --only=g,y
 *   node scripts/build-dialog-font-strip.mjs --unpin-all
 *
 * Accepted glyphs are pinned under out/pinned/. Default rebuilds keep pins and
 * only auto-add brand-new characters. --only re-picks just those letters.
 *
 * Drop more PNGs into the OCR Dialog font folder; name them freely. Each file
 * must contain the line "You find: …!" (or set LABELS below / sidecar .txt).
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./lib/png.mjs";

const SOURCE_DIR =
  "W:\\005 Dev\\03 Alt1 Custom Apps\\Arch reference\\OCR Dialog font";
const OUT_DIR = path.join(SOURCE_DIR, "out");
const GLYPH_DIR = path.join(OUT_DIR, "glyphs");
const PIN_DIR = path.join(OUT_DIR, "pinned");

const args = process.argv.slice(2);
const unpinAll = args.includes("--unpin-all");
const onlyArg = args.find((a) => a.startsWith("--only="));
const onlyChars = new Set(
  (onlyArg ? onlyArg.slice("--only=".length) : "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((token) => {
      // Allow --only=t or --only=tt (same letter twice) or literal multi-char if length 1
      if (token.length === 1) return [token];
      // Named punctuation keys
      const named = {
        slash: "/",
        colon: ":",
        bang: "!",
        qmark: "?",
        apos: "'",
        lparen: "(",
        rparen: ")",
        comma: ",",
        dot: ".",
        hyphen: "-",
      };
      if (named[token]) return [named[token]];
      // Fallback: each character in the token
      return [...token];
    }),
);

/** Full Alt1 order used by artefact-dialogue OCR (no space — spacewidth meta). */
const CHAR_ORDER =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'():,.-!?/";

/** Known labels when the filename has no sidecar .txt (\\n = multi-line). */
const LABELS_BY_STEM = {
  "1": "You find: Venator light crossbow (damaged)!",
  "2": "What treasure will you discover here, buried beneath the\\nsands?",
  "3": "Hello, old friend. Welcome to the Kharid-et Dig Site.",
  "4":
    "Husafell, before we talk of Kharid-et in general, I need to\\ndiscuss with you a matter of some urgency.",
};

const GAP_PX = 2;
const PLACEHOLDER_W = 8;
/** Parchment ~180+; ink cores ~10–40; AA edges higher — keep soft edges. */
const INK_LUMA_MAX = 110;

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const listSourcePngs = () =>
  fs
    .readdirSync(SOURCE_DIR)
    .filter((name) => /\.png$/i.test(name) && !name.startsWith("."))
    .map((name) => path.join(SOURCE_DIR, name))
    .filter((filePath) => {
      const stem = path.basename(filePath, path.extname(filePath));
      const sidecar = path.join(SOURCE_DIR, `${stem}.txt`);
      if (fs.existsSync(sidecar) || LABELS_BY_STEM[stem]) return true;
      console.warn(`SKIP ${path.basename(filePath)}: no .txt label (add one to include)`);
      return false;
    });

/** Returns one string per text line (multi-line crops supported). */
const labelsFor = (filePath) => {
  const stem = path.basename(filePath, path.extname(filePath));
  const sidecar = path.join(SOURCE_DIR, `${stem}.txt`);
  const raw = fs.existsSync(sidecar)
    ? fs.readFileSync(sidecar, "utf8")
    : LABELS_BY_STEM[stem];
  if (!raw) {
    throw new Error(
      `No label for ${path.basename(filePath)} — add ${stem}.txt or LABELS_BY_STEM`,
    );
  }
  return raw
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
};

const isInk = (data, index) => {
  const a = data[index + 3];
  if (a < 200) return false;
  return luma(data[index], data[index + 1], data[index + 2]) <= INK_LUMA_MAX;
};

/** Softer edge pixels kept when cropping so thin stems (i/l/!) keep AA. */
const isSoftInk = (data, index) => {
  const a = data[index + 3];
  if (a < 200) return false;
  return luma(data[index], data[index + 1], data[index + 2]) <= 155;
};

/** Contiguous ink-row bands (one per dialogue line). */
const findLineBands = (width, height, data) => {
  const row = new Uint16Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isInk(data, (y * width + x) * 4)) row[y] += 1;
    }
  }
  const bands = [];
  let y = 0;
  while (y < height) {
    while (y < height && !row[y]) y += 1;
    if (y >= height) break;
    const start = y;
    while (y < height && row[y]) y += 1;
    // Keep scanning across tiny gaps inside a line (rare); stop at real leading.
    while (y < height && y - start < 22) {
      let gap = 0;
      let yy = y;
      while (yy < height && !row[yy] && gap < 3) {
        gap += 1;
        yy += 1;
      }
      if (gap >= 3 || yy >= height || !row[yy]) break;
      y = yy;
      while (y < height && row[y]) y += 1;
    }
    bands.push({ minY: start, maxY: y - 1 });
  }
  return bands.filter((b) => b.maxY - b.minY + 1 >= 6);
};

/**
 * Segment by column ink runs (zero-gap separators). Touching letters that share
 * a column stay one run — if count is short, split widest runs at valleys.
 */
const segmentColumnRuns = (width, height, data, wantCount, y0 = 0, y1 = height - 1) => {
  const col = new Uint16Array(width);
  let minY = height;
  let maxY = -1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isInk(data, (y * width + x) * 4)) continue;
      col[x] += 1;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxY < 0) return { runs: [], minY: y0, maxY: y1 };

  const runs = [];
  let x = 0;
  while (x < width) {
    while (x < width && !col[x]) x += 1;
    if (x >= width) break;
    const start = x;
    while (x < width && col[x]) x += 1;
    runs.push({ start, end: x - 1 });
  }

  const splitAtValley = (run) => {
    let bestX = -1;
    let bestScore = Infinity;
    for (let cx = run.start + 1; cx <= run.end - 1; cx += 1) {
      const score = col[cx] * 10 + (col[cx - 1] + col[cx + 1]);
      if (score < bestScore) {
        bestScore = score;
        bestX = cx;
      }
    }
    if (bestX < 0) return null;
    return [
      { start: run.start, end: bestX - 1 },
      { start: bestX + (col[bestX] === 0 ? 1 : 0), end: run.end },
    ].filter((r) => r.end >= r.start);
  };

  // If over-segmented, merge the closest pair until count matches.
  while (runs.length > wantCount && runs.length >= 2) {
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < runs.length - 1; i += 1) {
      const gap = runs[i + 1].start - runs[i].end;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    runs[best] = { start: runs[best].start, end: runs[best + 1].end };
    runs.splice(best + 1, 1);
  }

  // If under-segmented, split widest runs at column valleys.
  while (runs.length < wantCount) {
    let wide = 0;
    for (let i = 1; i < runs.length; i += 1) {
      if (runs[i].end - runs[i].start > runs[wide].end - runs[wide].start) {
        wide = i;
      }
    }
    const parts = splitAtValley(runs[wide]);
    if (!parts || parts.length < 2) break;
    runs.splice(wide, 1, ...parts);
  }

  // Soft AA lives outside the hard-ink core — widen each run by one column when
  // neighbour columns still have grey edge pixels and don't collide.
  const soft = (cx) => {
    if (cx < 0 || cx >= width) return false;
    for (let y = y0; y <= y1; y += 1) {
      const i = (y * width + cx) * 4;
      if (data[i + 3] < 200) continue;
      const L = luma(data[i], data[i + 1], data[i + 2]);
      if (L <= 155) return true;
    }
    return false;
  };
  for (let i = 0; i < runs.length; i += 1) {
    const leftLimit = i > 0 ? runs[i - 1].end + 1 : 0;
    const rightLimit = i < runs.length - 1 ? runs[i + 1].start - 1 : width - 1;
    if (runs[i].start > leftLimit && soft(runs[i].start - 1)) {
      runs[i].start -= 1;
    }
    if (runs[i].end < rightLimit && soft(runs[i].end + 1)) {
      runs[i].end += 1;
    }
  }

  return { runs, minY, maxY, col };
};

const cropRun = (width, height, data, run, bandMinY, bandMaxY) => {
  // Extra rows below the ink band so descenders (g/y/p/q/j) keep their loop.
  const y0 = Math.max(0, bandMinY - 1);
  const y1 = Math.min(height - 1, bandMaxY + 3);
  const rowLit = new Uint16Array(y1 - y0 + 1);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = run.start; x <= run.end; x += 1) {
      if (!isSoftInk(data, (y * width + x) * 4)) continue;
      rowLit[y - y0] += 1;
    }
  }
  // Keep the main contiguous ink band — ignore stray pixels below/above.
  let bestStart = 0;
  let bestEnd = -1;
  let bestLen = 0;
  let i = 0;
  while (i < rowLit.length) {
    while (i < rowLit.length && !rowLit[i]) i += 1;
    if (i >= rowLit.length) break;
    const start = i;
    while (i < rowLit.length && rowLit[i]) i += 1;
    // Allow 1 empty row inside a glyph (i-dot gaps already handled by columns).
    while (i < rowLit.length && i - start < 18) {
      let gap = 0;
      let j = i;
      while (j < rowLit.length && !rowLit[j] && gap < 2) {
        gap += 1;
        j += 1;
      }
      if (gap >= 2 || j >= rowLit.length || !rowLit[j]) break;
      i = j;
      while (i < rowLit.length && rowLit[i]) i += 1;
    }
    const end = i - 1;
    const len = end - start + 1;
    if (len > bestLen) {
      bestLen = len;
      bestStart = start;
      bestEnd = end;
    }
  }
  let minY = y0 + bestStart;
  let maxY = y0 + bestEnd;
  if (bestEnd < 0) {
    minY = bandMinY;
    maxY = bandMaxY;
  }
  const gw = run.end - run.start + 1;
  const gh = maxY - minY + 1;
  const out = Buffer.alloc(gw * gh * 4);
  for (let p = 3; p < out.length; p += 4) out[p] = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = run.start; x <= run.end; x += 1) {
      const sx = (y * width + x) * 4;
      if (!isSoftInk(data, sx)) continue;
      const dx = ((y - minY) * gw + (x - run.start)) * 4;
      const strength = Math.max(
        0,
        Math.min(
          255,
          Math.round(255 - luma(data[sx], data[sx + 1], data[sx + 2]) * 1.1),
        ),
      );
      out[dx] = 255;
      out[dx + 1] = 255;
      out[dx + 2] = 255;
      out[dx + 3] = strength;
    }
  }
  return { width: gw, height: gh, data: out, minY, maxY };
};

const expectedNonSpace = (label) => [...label].filter((c) => c !== " ");

const extractFromFile = (filePath) => {
  const lines = labelsFor(filePath);
  const label = lines.join(" / ");
  const png = decodePng(fs.readFileSync(filePath));
  const bands = findLineBands(png.width, png.height, png.data);
  const glyphs = [];
  const lineReports = [];

  if (bands.length !== lines.length) {
    return {
      file: path.basename(filePath),
      label,
      ok: false,
      got: bands.length,
      want: lines.length,
      comps: bands.map((b) => ({
        x: 0,
        w: png.width,
        h: b.maxY - b.minY + 1,
      })),
      note: "line-band count mismatch",
    };
  }

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const want = expectedNonSpace(line);
    const band = bands[li];
    const { runs, minY, maxY } = segmentColumnRuns(
      png.width,
      png.height,
      png.data,
      want.length,
      band.minY,
      band.maxY,
    );
    lineReports.push({
      line: li,
      got: runs.length,
      want: want.length,
      ok: runs.length === want.length,
    });
    if (runs.length !== want.length) {
      return {
        file: path.basename(filePath),
        label,
        ok: false,
        got: runs.length,
        want: want.length,
        comps: runs.map((r) => ({
          x: r.start,
          w: r.end - r.start + 1,
          h: maxY - minY + 1,
        })),
        lineReports,
      };
    }

    const baselineY = maxY;
    let ci = 0;
    for (const ch of line) {
      if (ch === " ") continue;
      const crop = cropRun(
        png.width,
        png.height,
        png.data,
        runs[ci],
        Math.max(0, minY - 1),
        Math.min(png.height - 1, maxY + 1),
      );
      glyphs.push({
        ch,
        ...crop,
        baselineFromBottom: baselineY - crop.maxY,
        sourceY: crop.minY,
      });
      ci += 1;
    }
  }

  return {
    file: path.basename(filePath),
    label,
    ok: true,
    glyphs,
    baselineY: Math.max(...glyphs.map((g) => g.maxY)),
    lineReports,
  };
};

const charKey = (ch) => {
  if (ch === "/") return "slash";
  if (ch === ":") return "colon";
  if (ch === "!") return "bang";
  if (ch === "?") return "qmark";
  if (ch === "'") return "apos";
  if (ch === "(") return "lparen";
  if (ch === ")") return "rparen";
  if (ch === ",") return "comma";
  if (ch === ".") return "dot";
  if (ch === "-") return "hyphen";
  if (ch === " ") return "space";
  // Windows can't store W.png and w.png as distinct files.
  if (ch >= "A" && ch <= "Z") return `U-${ch}`;
  if (ch >= "a" && ch <= "z") return `L-${ch}`;
  if (ch >= "0" && ch <= "9") return `D-${ch}`;
  return `X-${ch.codePointAt(0)}`;
};

const charFromKey = (key) => {
  const named = {
    slash: "/",
    colon: ":",
    bang: "!",
    qmark: "?",
    apos: "'",
    lparen: "(",
    rparen: ")",
    comma: ",",
    dot: ".",
    hyphen: "-",
    space: " ",
  };
  if (named[key]) return named[key];
  if (/^U-[A-Z]$/.test(key)) return key.slice(2);
  if (/^L-[a-z]$/.test(key)) return key.slice(2);
  if (/^D-[0-9]$/.test(key)) return key.slice(2);
  if (/^X-\d+$/.test(key)) return String.fromCodePoint(Number(key.slice(2)));
  // Legacy single-letter pins (ambiguous on Windows — prefer lower).
  if (key.length === 1) return key;
  return null;
};

const pinPath = (ch) => path.join(PIN_DIR, `${charKey(ch)}.png`);

const loadPinnedGlyph = (ch) => {
  const file = pinPath(ch);
  if (!fs.existsSync(file)) return null;
  const png = decodePng(fs.readFileSync(file));
  return {
    ch,
    width: png.width,
    height: png.height,
    data: png.data,
    minY: 0,
    maxY: png.height - 1,
    baselineFromBottom: 0,
    pinned: true,
  };
};

const loadAllPins = () => {
  const map = new Map();
  if (!fs.existsSync(PIN_DIR)) return map;
  for (const name of fs.readdirSync(PIN_DIR)) {
    if (!/\.png$/i.test(name)) continue;
    const key = name.replace(/\.png$/i, "");
    const ch = charFromKey(key);
    if (!ch || !CHAR_ORDER.includes(ch)) continue;
    const g = loadPinnedGlyph(ch);
    if (g) map.set(ch, g);
  }
  return map;
};

/** First-time: seed pins from current out/glyphs if pinned/ is empty. */
const seedPinsFromGlyphsIfNeeded = () => {
  fs.mkdirSync(PIN_DIR, { recursive: true });
  const existing = fs
    .readdirSync(PIN_DIR)
    .filter((n) => /\.png$/i.test(n));
  if (existing.length || !fs.existsSync(GLYPH_DIR)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(GLYPH_DIR)) {
    if (!/\.png$/i.test(name)) continue;
    fs.copyFileSync(path.join(GLYPH_DIR, name), path.join(PIN_DIR, name));
    n += 1;
  }
  return n;
};

/** Prefer typical crops — reject merged blobs (e.g. "tt") and stub stems. */
const pickBestGlyph = (samples) => {
  if (samples.length === 1) return samples[0];
  const widths = samples.map((g) => g.width).sort((a, b) => a - b);
  const heights = samples.map((g) => g.height).sort((a, b) => a - b);
  const medW = widths[(widths.length / 2) | 0];
  const medH = heights[(heights.length / 2) | 0];
  const inkOf = (g) => {
    let ink = 0;
    for (let i = 3; i < g.data.length; i += 4) ink += g.data[i];
    return ink;
  };
  /** Left-edge full-height stem → neighbour bleed (i/l into g, etc.). */
  const leftStemBleed = (g) => {
    let lit = 0;
    for (let y = 0; y < g.height; y += 1) {
      if (g.data[(y * g.width + 0) * 4 + 3] > 40) lit += 1;
    }
    return lit / g.height > 0.7;
  };
  const bottomInk = (g) => {
    const y0 = Math.floor(g.height * 0.55);
    let ink = 0;
    for (let y = y0; y < g.height; y += 1) {
      for (let x = 0; x < g.width; x += 1) {
        ink += g.data[(y * g.width + x) * 4 + 3];
      }
    }
    return ink;
  };
  const score = (g) => {
    const dw = Math.abs(g.width - medW);
    const dh = Math.abs(g.height - medH);
    let s = dw * 500 + dh * 200 - inkOf(g) * 0.01;
    if (leftStemBleed(g)) s += 5000;
    // Descenders: reward a filled lower loop (g/y/p/q/j).
    if ("gypqj".includes(g.ch)) s -= bottomInk(g) * 0.02;
    // Thin stems (l/i): prefer keeping a soft AA column when available.
    if ("li".includes(g.ch) && g.width === 2 && medW <= 1) s -= 900;
    // Reject absurdly tall crops (stray pixels below the stem).
    if (g.height > medH + 3) s += 3000;
    return s;
  };
  return [...samples].sort((a, b) => score(a) - score(b))[0];
};

const buildStrip = (byChar, glyphHeight, baseline, charOrder = CHAR_ORDER) => {
  // glyph area height + 1 red marker row
  const h = glyphHeight + 1;
  let totalW = 0;
  const slots = [];
  for (const ch of charOrder) {
    const g = byChar.get(ch);
    const w = g ? g.width : PLACEHOLDER_W;
    const advance = g ? w + 1 : w;
    slots.push({ ch, g, w, advance, present: Boolean(g) });
    totalW += advance + GAP_PX;
  }
  if (totalW <= 0) totalW = 1;

  const data = Buffer.alloc(totalW * h * 4);
  // Black background
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }

  let x = 0;
  for (const slot of slots) {
    // Advance width = ink + 1px letter gap. Red marks encode advance for OCR.
    const advance = slot.advance;
    if (slot.g) {
      const g = slot.g;
      // Align glyph bottoms to shared baseline row (above marker)
      const destBottom = baseline; // y of last glyph pixel row
      const srcBottom = g.height - 1;
      for (let gy = 0; gy < g.height; gy += 1) {
        const dy = destBottom - (srcBottom - gy);
        if (dy < 0 || dy >= glyphHeight) continue;
        for (let gx = 0; gx < g.width; gx += 1) {
          const si = (gy * g.width + gx) * 4;
          const a = g.data[si + 3];
          if (a < 8) continue;
          const di = (dy * totalW + (x + gx)) * 4;
          // soft AA: store strength in RGB brightness for visibility
          const v = a;
          data[di] = v;
          data[di + 1] = v;
          data[di + 2] = v;
          data[di + 3] = 255;
        }
      }
      // Red width mark (advance, not just ink)
      for (let mx = 0; mx < advance; mx += 1) {
        const di = ((h - 1) * totalW + (x + mx)) * 4;
        data[di] = 255;
        data[di + 1] = 0;
        data[di + 2] = 0;
        data[di + 3] = 255;
      }
    } else {
      // Dim placeholder gap (dark gray block) so missing slots are visible
      for (let gy = 2; gy < glyphHeight - 2; gy += 1) {
        for (let gx = 1; gx < slot.w - 1; gx += 1) {
          const di = (gy * totalW + (x + gx)) * 4;
          data[di] = 40;
          data[di + 1] = 40;
          data[di + 2] = 48;
          data[di + 3] = 255;
        }
      }
      // Blue marker = missing
      for (let mx = 0; mx < advance; mx += 1) {
        const di = ((h - 1) * totalW + (x + mx)) * 4;
        data[di] = 40;
        data[di + 1] = 90;
        data[di + 2] = 200;
        data[di + 3] = 255;
      }
    }
    x += advance + GAP_PX;
  }

  return { width: totalW, height: h, data, slots };
};

const toDataUrl = (image) =>
  `data:image/png;base64,${encodePng(image).toString("base64")}`;

const tinyGlyphPreview = (g, scale = 3) => {
  // Rasterize alpha glyph to opaque black-on-cream for canvas img
  const w = g.width * scale;
  const h = g.height * scale;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = (((y / scale) | 0) * g.width + ((x / scale) | 0)) * 4;
      const a = g.data[si + 3];
      const di = (y * w + x) * 4;
      if (a > 20) {
        const v = Math.max(0, 255 - a);
        data[di] = v;
        data[di + 1] = v;
        data[di + 2] = v;
      } else {
        data[di] = 232;
        data[di + 1] = 224;
        data[di + 2] = 200;
      }
      data[di + 3] = 255;
    }
  }
  return { width: w, height: h, data };
};

fs.mkdirSync(GLYPH_DIR, { recursive: true });
fs.mkdirSync(PIN_DIR, { recursive: true });

if (unpinAll) {
  for (const name of fs.readdirSync(PIN_DIR)) {
    if (/\.png$/i.test(name)) fs.unlinkSync(path.join(PIN_DIR, name));
  }
  console.log("Cleared all pins (--unpin-all)");
} else {
  const seeded = seedPinsFromGlyphsIfNeeded();
  if (seeded) console.log(`Seeded ${seeded} pins from existing glyphs/`);
}

const files = listSourcePngs();
if (!files.length) {
  console.error("No PNGs in", SOURCE_DIR);
  process.exit(1);
}

const reports = [];
/** @type {Map<string, object[]>} */
const samplesByChar = new Map();

for (const file of files) {
  const result = extractFromFile(file);
  reports.push(result);
  if (!result.ok) {
    console.warn(
      `SKIP ${result.file}: segmented ${result.got} glyphs, expected ${result.want} for "${result.label}"`,
    );
    console.warn("  boxes", JSON.stringify(result.comps));
    continue;
  }
  console.log(
    `OK ${result.file}: ${result.glyphs.length} glyphs from "${result.label}"`,
  );
  for (const g of result.glyphs) {
    if (!samplesByChar.has(g.ch)) samplesByChar.set(g.ch, []);
    samplesByChar.get(g.ch).push(g);
  }
}

const pinned = loadAllPins();
const byChar = new Map();
const refreshed = [];
const keptPinned = [];
const newlyAdded = [];

const shouldRefresh = (ch) => {
  if (unpinAll) return true;
  if (onlyChars.size) return onlyChars.has(ch);
  // Default: keep pin if present; only auto-pick brand-new letters.
  return !pinned.has(ch);
};

for (const ch of new Set([...samplesByChar.keys(), ...pinned.keys()])) {
  if (!shouldRefresh(ch) && pinned.has(ch)) {
    byChar.set(ch, pinned.get(ch));
    keptPinned.push(ch);
    continue;
  }
  const samples = samplesByChar.get(ch);
  if (!samples?.length) {
    if (pinned.has(ch)) {
      byChar.set(ch, pinned.get(ch));
      keptPinned.push(ch);
    }
    continue;
  }
  const picked = pickBestGlyph(samples);
  byChar.set(ch, picked);
  if (pinned.has(ch)) refreshed.push(ch);
  else newlyAdded.push(ch);
}

if (onlyChars.size) {
  for (const ch of onlyChars) {
    if (!byChar.has(ch) && !samplesByChar.has(ch)) {
      console.warn(`--only=${ch}: no samples found in source crops`);
    }
  }
}

console.log(
  `Pins: kept ${keptPinned.length}, refreshed ${refreshed.join("") || "—"}, new ${newlyAdded.join("") || "—"}`,
);

// Persist pins for every glyph we ship in the strip.
for (const [ch, g] of byChar) {
  fs.writeFileSync(
    pinPath(ch),
    encodePng({ width: g.width, height: g.height, data: g.data }),
  );
}

// Shared canvas height / baseline from collected glyphs
let maxAscend = 0;
let maxDescend = 0;
for (const g of byChar.values()) {
  // We store glyph cropped tightly; treat bottom as baseline for now
  maxAscend = Math.max(maxAscend, g.height);
  maxDescend = Math.max(maxDescend, g.baselineFromBottom ?? 0);
}
const glyphHeight = Math.max(12, maxAscend + maxDescend);
const baseline = glyphHeight - 1 - maxDescend;

const strip = buildStrip(byChar, glyphHeight, baseline);
fs.writeFileSync(path.join(OUT_DIR, "strip-partial.png"), encodePng(strip));

const present = [...byChar.keys()].sort(
  (a, b) => CHAR_ORDER.indexOf(a) - CHAR_ORDER.indexOf(b),
);
const missing = [...CHAR_ORDER].filter((c) => !byChar.has(c));

// Ship strip: present glyphs only (no blue placeholders) for live OCR.
const shipStrip = buildStrip(byChar, glyphHeight, baseline, present);
const shipChars = present.join("");
const fontMeta = {
  basey: baseline,
  spacewidth: 1,
  treshold: 0.3,
  color: [255, 255, 255],
  unblendmode: "blackbg",
  shadow: false,
  chars: shipChars,
  seconds: ".,'!:;",
};
fs.writeFileSync(path.join(OUT_DIR, "strip-ship.png"), encodePng(shipStrip));
fs.writeFileSync(
  path.join(OUT_DIR, "dialog-ocr.fontmeta.json"),
  `${JSON.stringify(fontMeta, null, 2)}\n`,
);

// Copy into the Vite app so dig-popup OCR can import the real glyphs.
const { fileURLToPath } = await import("node:url");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = path.join(repoRoot, "src", "assets");
fs.mkdirSync(assetDir, { recursive: true });
fs.writeFileSync(
  path.join(assetDir, "dialog-ocr.data.png"),
  encodePng(shipStrip),
);
fs.writeFileSync(
  path.join(assetDir, "dialog-ocr.fontmeta.json"),
  `${JSON.stringify(fontMeta, null, 2)}\n`,
);
console.log(`Shipped ${path.join(assetDir, "dialog-ocr.data.png")} (${shipChars.length} chars)`);

for (const [ch, g] of byChar) {
  fs.writeFileSync(
    path.join(GLYPH_DIR, `${charKey(ch)}.png`),
    encodePng({ width: g.width, height: g.height, data: g.data }),
  );
}

const glyphPreviews = {};
for (const [ch, g] of byChar) {
  glyphPreviews[ch] = toDataUrl(tinyGlyphPreview(g, 4));
}

const coverage = {
  updatedAt: new Date().toISOString(),
  sourceDir: SOURCE_DIR,
  files: reports.map((r) => ({
    file: r.file,
    label: r.label,
    ok: r.ok,
    got: r.ok ? r.glyphs.length : r.got,
    want: r.ok ? r.glyphs.length : r.want,
  })),
  charOrder: CHAR_ORDER,
  present,
  missing,
  counts: {
    present: present.length,
    missing: missing.length,
    total: CHAR_ORDER.length,
    pct: Math.round((present.length / CHAR_ORDER.length) * 1000) / 10,
  },
  strip: {
    width: strip.width,
    height: strip.height,
    path: path.join(OUT_DIR, "strip-partial.png"),
    dataUrl: toDataUrl(strip),
    gapPx: GAP_PX,
    scaleHint: 2,
    slots: strip.slots.map(({ ch, w, present }) => ({ ch, w, present })),
  },
  glyphs: present.map((ch) => ({
    ch,
    width: byChar.get(ch).width,
    height: byChar.get(ch).height,
    preview: glyphPreviews[ch],
  })),
};

fs.writeFileSync(
  path.join(OUT_DIR, "coverage.json"),
  JSON.stringify(
    {
      ...coverage,
      strip: { ...coverage.strip, dataUrl: undefined },
      glyphs: coverage.glyphs.map(({ preview, ...rest }) => rest),
    },
    null,
    2,
  ),
);

// Canvas-friendly dump (includes data URLs)
fs.writeFileSync(
  path.join(OUT_DIR, "coverage-canvas.json"),
  JSON.stringify(coverage),
);

console.log(
  `Coverage ${coverage.counts.present}/${coverage.counts.total} (${coverage.counts.pct}%)`,
);
console.log(`Present: ${present.join("")}`);
console.log(`Missing: ${missing.join("")}`);
console.log(`Wrote ${path.join(OUT_DIR, "strip-partial.png")}`);

try {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const emit = spawnSync(
    process.execPath,
    [path.join(here, "emit-dialog-font-canvas.mjs")],
    { stdio: "inherit" },
  );
  if (emit.status) console.warn("canvas emit failed", emit.status);
} catch (err) {
  console.warn("canvas emit skipped", err?.message ?? err);
}
