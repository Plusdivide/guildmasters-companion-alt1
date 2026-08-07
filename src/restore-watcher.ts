/**
 * Live Archaeology restoration tracking.
 *
 * Locates the RESTORATION window via a gold title signature (same idea as
 * bank/workbench detect), reads the selected artefact, then watches the craft
 * popup's N/M progress so inventory only updates for completed restores.
 *
 * Performance rules:
 * - Idle / walking: slow poll, title glyph signature only — never OCR.
 * - Window open: OCR only under that title (name once, then progress).
 * - Status callbacks only when phase/message actually changes.
 */
import * as a1lib from "alt1/base";
import * as OCR from "alt1/ocr";
import fontAa10Mono from "alt1/fonts/aa_10px_mono.js";
import fontChat12 from "alt1/fonts/chatbox/12pt.js";
import digitFont from "alt1/fonts/pixel_8px_digits.js";
import { archaeologyData } from "./data";
import { matchArtefactText } from "./alt1";
import type { Artefact } from "./types";
import { isDevToolsActive } from "./dev-tools";
import {
  TITLE_GLYPH_TOLERANCE,
  findRestorationTitle,
  isGlyphPixel,
  locateRestorationInImage,
  signatureFrom,
  type Area,
  type TitleSignature,
} from "./restore-detect";
import {
  findCraftNameBand,
  readCraftProgress,
} from "./craft-detect";
// Bundled so Alt1 doesn't depend on a separate /ui/ fetch that can 404 or cache null.
import titleRestorationUrl from "./assets/title-restoration.png";

const unwrapFont = (value: unknown): OCR.FontDefinition => {
  let current: unknown = value;
  while (current && typeof current === "object" && "default" in current) {
    current = (current as { default: unknown }).default;
  }
  return current as OCR.FontDefinition;
};

/** One name font + one digit font — enough once the window is open. */
const NAME_FONT = unwrapFont(fontChat12);
const PROGRESS_FONT = unwrapFont(digitFont);
const PROGRESS_FONT_FALLBACK = unwrapFont(fontAa10Mono);

const WHITE_TEXT: OCR.ColortTriplet[] = [
  [255, 255, 255],
  [240, 240, 240],
  [220, 220, 220],
];

/** Idle = title glyph hunt only. Active = OCR after title is confirmed. */
export const RESTORE_IDLE_MS = 3000;
export const RESTORE_ACTIVE_MS = 280;

type TitleHit = Area;

export type RestoreWatcherEvent = {
  type: "restored";
  artefact: Artefact;
  quantity: number;
  progress: string;
};

export type RestoreWatcherStatus = {
  phase: "idle" | "ready" | "restoring";
  artefactName?: string;
  progress?: string;
  planned?: number;
  message: string;
};

type Session = {
  artefact: Artefact;
  lastN: number;
  plannedM: number;
  titleAt: TitleHit;
};

const bitmapToImageData = async (blob: Blob): Promise<ImageData | null> => {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
};

const imageUrlToImageData = (url: string): Promise<ImageData | null> =>
  new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });

let signaturePromise: Promise<TitleSignature | null> | null = null;

const loadTitleSignature = (): Promise<TitleSignature | null> => {
  signaturePromise ??= (async () => {
    try {
      // Bundled asset first, then public/ui fallback.
      const urls = [
        titleRestorationUrl,
        `${import.meta.env.BASE_URL}ui/title-restoration.png`,
      ];
      for (const url of urls) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const image = await bitmapToImageData(await response.blob());
            const signature = image ? signatureFrom(image) : null;
            if (signature) return signature;
          }
        } catch {
          // try Image() path
        }
        const fromImg = await imageUrlToImageData(url);
        const signature = fromImg ? signatureFrom(fromImg) : null;
        if (signature) return signature;
      }
      return null;
    } catch {
      return null;
    }
  })();
  return signaturePromise;
};

/** Fallback when glyph colour drifts — OCR gold bands for the word RESTORATION. */
const findRestorationTitleByOcr = (image: ImageData): TitleHit | null => {
  const gold: OCR.ColortTriplet[] = [
    [200, 145, 65],
    [198, 143, 60],
    [208, 165, 106],
    [240, 190, 121],
    [224, 177, 113],
    [255, 220, 150],
  ];
  const rows: { y: number; minX: number; maxX: number; count: number }[] = [];
  for (let y = 0; y < image.height; y += 2) {
    let minX = image.width;
    let maxX = -1;
    let count = 0;
    for (let x = 0; x < image.width; x += 2) {
      if (!isGlyphPixel(image.data, (y * image.width + x) * 4, 55)) continue;
      if (x < minX) minX = x;
      maxX = x;
      count += 1;
    }
    if (count >= 8) rows.push({ y, minX, maxX, count });
  }

  const bands: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }[] = [];
  for (const row of rows) {
    const band = bands.at(-1);
    if (band && row.y - band.maxY <= 4) {
      band.maxY = row.y;
      band.minX = Math.min(band.minX, row.minX);
      band.maxX = Math.max(band.maxX, row.maxX);
    } else {
      bands.push({
        minX: row.minX,
        maxX: row.maxX,
        minY: row.y,
        maxY: row.y,
      });
    }
  }

  for (const band of bands) {
    const width = band.maxX - band.minX + 1;
    const height = band.maxY - band.minY + 1;
    if (width < 70 || width > 280 || height > 40) continue;

    const pad = 4;
    const left = Math.max(0, band.minX - pad);
    const top = Math.max(0, band.minY - pad);
    const w = Math.min(image.width - left, width + pad * 2);
    const h = Math.min(image.height - top, height + pad * 2 + 8);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      const src = ((top + y) * image.width + left) * 4;
      data.set(image.data.subarray(src, src + w * 4), y * w * 4);
    }
    const crop = new ImageData(data, w, h);

    const seeds = [
      [8, Math.floor(h / 2)],
      [24, Math.floor(h / 2)],
    ];
    for (const [sx, sy] of seeds) {
      try {
        const line = OCR.findReadLine(crop, NAME_FONT, gold, sx, sy, 40, 2);
        const text = (line?.text ?? "").toUpperCase().replace(/[^A-Z]/g, "");
        if (text.includes("RESTORATION") || text.includes("RESTORAT")) {
          return { x: left, y: top, width: w, height: h };
        }
      } catch {
        // miss
      }
    }
  }
  return null;
};

/** Re-find the title near the last hit — glyph only (no OCR). */
const findTitleNear = (
  approx: TitleHit,
  signature: TitleSignature,
): TitleHit | null => {
  const padX = 160;
  const padY = 80;
  const left = Math.max(0, approx.x - padX);
  const top = Math.max(0, approx.y - padY);
  const width = Math.min(480, approx.width + padX * 2 + 100);
  const height = Math.min(180, approx.height + padY * 2 + 40);
  const region = captureRegion(left, top, width, height);
  if (!region) return null;

  for (const tolerance of [TITLE_GLYPH_TOLERANCE, 45, 90]) {
    const hit = findRestorationTitle(region, signature, tolerance);
    if (hit) {
      return {
        x: hit.x + left,
        y: hit.y + top,
        width: hit.width,
        height: hit.height,
      };
    }
  }
  return null;
};

type LocateResult = {
  title: TitleHit;
  via: "signature";
};

/**
 * Title locate — same idea as bank `detectInterface` / `locateStorage`:
 * gold title signature on a plain capture. Mid/wide first, then full RS.
 */
const locateRestorationTitle = (
  signature: TitleSignature | null,
  near: TitleHit | null,
  _allowOcr = false,
  cheap = false,
): LocateResult | null => {
  const tryCapture = (
    captured: { image: ImageData; left: number; top: number } | null,
  ): LocateResult | null => {
    if (!captured) return null;
    const hit = locateRestorationInImage(captured.image, signature);
    if (!hit) return null;
    return {
      title: {
        x: hit.title.x + captured.left,
        y: hit.title.y + captured.top,
        width: hit.title.width,
        height: hit.title.height,
      },
      via: "signature",
    };
  };

  if (near && signature) {
    const local = findTitleNear(near, signature);
    if (local) return { title: local, via: "signature" };
  }

  const mid = tryCapture(captureUiBand()) ?? tryCapture(captureUiBandWide());
  if (mid) return mid;
  if (cheap) return null;
  return tryCapture(captureFullRs());
};

/** Mid-screen band — proven path for RESTORATION title locate. */
const captureUiBand = (): {
  image: ImageData;
  left: number;
  top: number;
} | null => {
  try {
    const w = window.alt1?.rsWidth ?? 0;
    const h = window.alt1?.rsHeight ?? 0;
    if (w < 200 || h < 200) return null;
    const left = Math.floor(w * 0.15);
    const top = Math.floor(h * 0.08);
    const width = Math.floor(w * 0.7);
    const height = Math.floor(h * 0.7);
    const image = a1lib.capture(left, top, width, height);
    if (!image?.data) return null;
    return { image, left, top };
  } catch {
    return null;
  }
};

/** Wider band when the window sits nearer the screen edge. */
const captureUiBandWide = (): {
  image: ImageData;
  left: number;
  top: number;
} | null => {
  try {
    const w = window.alt1?.rsWidth ?? 0;
    const h = window.alt1?.rsHeight ?? 0;
    if (w < 200 || h < 200) return null;
    const left = Math.floor(w * 0.05);
    const top = Math.floor(h * 0.03);
    const width = Math.floor(w * 0.9);
    const height = Math.floor(h * 0.9);
    const image = a1lib.capture(left, top, width, height);
    if (!image?.data) return null;
    return { image, left, top };
  } catch {
    return null;
  }
};

/** Full game client — last resort when the window is off the mid bands. */
const captureFullRs = (): {
  image: ImageData;
  left: number;
  top: number;
} | null => {
  try {
    const w = window.alt1?.rsWidth ?? 0;
    const h = window.alt1?.rsHeight ?? 0;
    if (w < 200 || h < 200) return null;
    const image = a1lib.capture(0, 0, w, h);
    if (!image?.data) return null;
    return { image, left: 0, top: 0 };
  } catch {
    return null;
  }
};

const captureRegion = (
  x: number,
  y: number,
  width: number,
  height: number,
): ImageData | null => {
  try {
    return a1lib.capture(x, y, width, height);
  } catch {
    return null;
  }
};

const unwrapBindRead = (raw: string): string => {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(trimmed) as {
      text?: string;
      fragments?: { text?: string }[];
    };
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      return parsed.text;
    }
    if (Array.isArray(parsed.fragments)) {
      return parsed.fragments.map((f) => f.text ?? "").join("");
    }
  } catch {
    // not JSON
  }
  return raw;
};

const parseProgress = (
  text: string,
): { n: number; m: number } | null => {
  const cleaned = unwrapBindRead(text).replace(/\s+/g, "");
  // Prefer N/M; also tolerate OCR "1l1", "1I1", "1|1".
  const match =
    cleaned.match(/(\d+)\s*[\/|lI]\s*(\d+)/) ??
    cleaned.match(/(\d+)\/(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(n) || !Number.isFinite(m) || m < 1 || m > 99) return null;
  if (n < 0 || n > m) return null;
  return { n, m };
};

const normalizeArtefactOcr = (text: string): string =>
  unwrapBindRead(text)
    .replace(/\(damaged\)/gi, "")
    .replace(/[’']/g, "'")
    .replace(/[^a-zA-Z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Token overlap fuzzy match for slightly garbled OCR. */
const fuzzyMatchArtefact = (text: string): Artefact | null => {
  const exact = matchArtefactText(text, archaeologyData.artefacts);
  if (exact) return exact;

  const normalized = normalizeArtefactOcr(text).toLowerCase();
  if (normalized.length < 4) return null;
  const tokens = normalized.split(" ").filter((t) => t.length > 2);
  if (!tokens.length) return null;

  let best: Artefact | null = null;
  let bestScore = 0;
  for (const artefact of archaeologyData.artefacts) {
    for (const name of [artefact.name, artefact.damagedName]) {
      const n = name.toLowerCase().replace(/\(damaged\)/g, "").trim();
      if (normalized.includes(n) || n.includes(normalized)) {
        const score = n.length + 50;
        if (score > bestScore) {
          best = artefact;
          bestScore = score;
        }
        continue;
      }
      const nameTokens = n.split(" ").filter((t) => t.length > 2);
      if (!nameTokens.length) continue;
      const hits = nameTokens.filter((t) =>
        tokens.some(
          (tok) =>
            tok === t ||
            (tok.length >= 4 && t.startsWith(tok.slice(0, 4))) ||
            (t.length >= 4 && tok.startsWith(t.slice(0, 4))),
        ),
      ).length;
      const score = hits / nameTokens.length;
      if (score >= 0.7 && hits * 10 + name.length > bestScore) {
        best = artefact;
        bestScore = hits * 10 + name.length;
      }
    }
  }
  return best;
};

/** OCR for N/M — tiny seed grid, only called after title is found. */
const readProgressSparse = (
  image: ImageData,
): { n: number; m: number; raw: string } | null => {
  // Pure green-bar ink reader (offline-proven) — works when OCR fonts miss white-on-green.
  const ink = readCraftProgress(image);
  if (ink) return { n: ink.n, m: ink.m, raw: ink.raw };

  const midX = Math.floor(image.width / 2);
  const ys = [
    Math.floor(image.height * 0.52),
    Math.floor(image.height * 0.6),
    100,
    116,
  ];
  const xs = [midX - 16, midX, midX + 16];

  for (const font of [PROGRESS_FONT, PROGRESS_FONT_FALLBACK]) {
    for (const y of ys) {
      if (y < 4 || y >= image.height - 4) continue;
      for (const x of xs) {
        if (x < 4 || x >= image.width - 4) continue;
        try {
          const line = OCR.findReadLine(image, font, WHITE_TEXT, x, y, 36, 2);
          const parsed = parseProgress(line?.text ?? "");
          if (parsed) return { ...parsed, raw: `${parsed.n}/${parsed.m}` };
        } catch {
          // miss
        }
      }
    }
  }
  return null;
};

/** OCR for artefact name — prefer the white name band, then sparse seeds. */
const readArtefactSparse = (image: ImageData): Artefact | null => {
  const progress = readCraftProgress(image);
  const band = findCraftNameBand(image, progress?.bar ?? null);
  const seeds: [number, number][] = [];
  if (band) {
    const midY = band.y + Math.floor(band.height / 2);
    seeds.push(
      [band.x + 8, midY],
      [band.x + Math.floor(band.width * 0.35), midY],
      [band.x + Math.floor(band.width * 0.55), midY],
    );
  }
  for (const y of [34, 46, 58, 78]) {
    for (const x of [56, 88, 120, 160]) seeds.push([x, y]);
  }

  for (const [x, y] of seeds) {
    if (y < 4 || y >= image.height - 4) continue;
    if (x < 4 || x >= image.width - 8) continue;
    try {
      const line = OCR.findReadLine(image, NAME_FONT, WHITE_TEXT, x, y, 90, 2);
      const text = normalizeArtefactOcr(line?.text ?? "");
      if (text.length < 4) continue;
      if (/^(restoration|cancel|done|materials|requirements)$/i.test(text)) {
        continue;
      }
      const hit = fuzzyMatchArtefact(text);
      if (hit) return hit;
    } catch {
      // miss
    }
  }
  return null;
};

const bindReadTextAt = (
  id: number,
  x: number,
  y: number,
  color: number,
): string => {
  const alt1 = window.alt1;
  if (!alt1) return "";
  try {
    if (alt1.bindReadColorString) {
      const text = unwrapBindRead(
        alt1.bindReadColorString(id, "chat", color, x, y) ?? "",
      );
      if (text.trim()) return text;
    }
    if (alt1.bindReadString) {
      const text = unwrapBindRead(alt1.bindReadString(id, "chat", x, y) ?? "");
      if (text.trim()) return text;
    }
  } catch {
    // miss
  }
  return "";
};

const bindReadProgress = (
  screenX: number,
  screenY: number,
  width: number,
  height: number,
): { n: number; m: number; raw: string } | null => {
  const alt1 = window.alt1;
  if (!alt1?.bindRegion) return null;
  try {
    const id = alt1.bindRegion(screenX, screenY, width, height);
    if (id <= 0) return null;
    const white = a1lib.mixColor(255, 255, 255);
    const mid = Math.floor(width / 2);
    const spots: [number, number][] = [
      [mid, Math.floor(height * 0.55)],
      [mid - 16, Math.floor(height * 0.55)],
      [mid, 100],
      [mid, 116],
    ];
    for (const [x, y] of spots) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const parsed = parseProgress(bindReadTextAt(id, x, y, white));
      if (parsed) return { ...parsed, raw: `${parsed.n}/${parsed.m}` };
    }
  } catch {
    // bind unavailable
  }
  return null;
};

const bindReadArtefact = (
  screenX: number,
  screenY: number,
  width: number,
  height: number,
): Artefact | null => {
  const alt1 = window.alt1;
  if (!alt1?.bindRegion) return null;
  try {
    const id = alt1.bindRegion(screenX, screenY, width, height);
    if (id <= 0) return null;
    const white = a1lib.mixColor(255, 255, 255);
    const spots: [number, number][] = [
      [56, 36],
      [88, 36],
      [120, 36],
      [56, 52],
      [100, 52],
      [140, 72],
    ];
    for (const [x, y] of spots) {
      if (x >= width || y >= height) continue;
      const text = normalizeArtefactOcr(bindReadTextAt(id, x, y, white));
      if (text.length < 4) continue;
      const hit = fuzzyMatchArtefact(text);
      if (hit) return hit;
    }
  } catch {
    // bind unavailable
  }
  return null;
};

const OVERLAY_GROUP = "archaeology-companion-restore";
/** Barely longer than RESTORE_ACTIVE_MS so a missed refresh clears the ghost outline fast. */
const OVERLAY_MS = 400;
const OVERLAY_WIDTH = 2;

type Alt1Overlay = {
  permissionOverlay?: boolean;
  overLayFreezeGroup: (group: string) => void;
  overLayClearGroup: (group: string) => void;
  overLaySetGroup: (group: string) => void;
  overLaySetGroupZIndex: (group: string, z: number) => void;
  overLayRect: (
    color: number,
    x: number,
    y: number,
    w: number,
    h: number,
    ms: number,
    width: number,
  ) => void;
  overLayRefreshGroup: (group: string) => void;
};

const alt1Overlay = (): Alt1Overlay | null => {
  const api = (typeof alt1 !== "undefined" ? alt1 : null) as Alt1Overlay | null;
  if (!api?.permissionOverlay || !api.overLayRect) return null;
  return api;
};

type OutlineKind = "craft" | "setup" | "title";

/** Green outline — craft is the small progress popup; setup is the large UI. */
const showRestoreOutline = (title: TitleHit, kind: OutlineKind): void => {
  if (!isDevToolsActive()) return;
  const api = alt1Overlay();
  if (!api) return;
  const green = a1lib.mixColor(70, 220, 80);

  let width: number;
  let height: number;
  let topPad: number;
  if (kind === "craft") {
    // Matches the small RESTORATION progress popup (~340×185).
    width = Math.max(300, title.width + 220);
    height = 185;
    topPad = 8;
  } else if (kind === "setup") {
    width = Math.max(480, title.width + 360);
    height = 340;
    topPad = 10;
  } else {
    // Title-only until we know which window — avoid a huge stale box.
    width = Math.max(title.width + 48, 160);
    height = Math.max(title.height + 20, 28);
    topPad = 4;
  }

  const x = Math.round(title.x + title.width / 2 - width / 2);
  const y = Math.round(title.y - topPad);

  api.overLayFreezeGroup(OVERLAY_GROUP);
  api.overLayClearGroup(OVERLAY_GROUP);
  api.overLaySetGroup(OVERLAY_GROUP);
  api.overLaySetGroupZIndex(OVERLAY_GROUP, 3);
  api.overLayRect(green, x, y, Math.round(width), height, OVERLAY_MS, OVERLAY_WIDTH);
  api.overLayRefreshGroup(OVERLAY_GROUP);
};

const clearRestoreOutline = (): void => {
  const api = alt1Overlay();
  if (!api) return;
  api.overLayFreezeGroup(OVERLAY_GROUP);
  api.overLayClearGroup(OVERLAY_GROUP);
  api.overLayRefreshGroup(OVERLAY_GROUP);
};

/** Cleared when developer tools are turned off in Settings. */
export const clearRestoreOutlinesForDev = clearRestoreOutline;

export class RestorationWatcher {
  private busy = false;
  private session: Session | null = null;
  private cachedTitle: TitleHit | null = null;
  private pendingProgress: { n: number; m: number; raw: string } | null = null;
  private status: RestoreWatcherStatus = {
    phase: "idle",
    message: "Not restoring",
  };
  /** While restoring, only re-read the artefact name occasionally. */
  private nameRetryAt = 0;
  private prepared = false;

  private onRestore: (event: RestoreWatcherEvent) => void;
  private onStatus: (status: RestoreWatcherStatus) => void;

  constructor(
    onRestore: (event: RestoreWatcherEvent) => void,
    onStatus: (status: RestoreWatcherStatus) => void,
  ) {
    this.onRestore = onRestore;
    this.onStatus = onStatus;
  }

  getStatus(): RestoreWatcherStatus {
    return this.status;
  }

  /** True while the RESTORATION window is open this session. */
  get active(): boolean {
    return this.cachedTitle !== null || this.session !== null;
  }

  /** CompanionWatcher owns the poll interval — reload title signature. */
  prepare(): void {
    signaturePromise = null;
    this.prepared = true;
  }

  reset(): void {
    this.session = null;
    this.cachedTitle = null;
    this.pendingProgress = null;
    this.prepared = false;
    clearRestoreOutline();
    this.setStatus({ phase: "idle", message: "Not restoring" });
  }

  private setStatus(next: RestoreWatcherStatus): void {
    const prev = this.status;
    if (
      prev.phase === next.phase &&
      prev.message === next.message &&
      prev.artefactName === next.artefactName &&
      prev.progress === next.progress &&
      prev.planned === next.planned
    ) {
      return;
    }
    this.status = next;
    this.onStatus(next);
  }

  /**
   * Cheap idle probe: mid/wide band only, no full-screen.
   * Trusts locateRestorationInImage (RESTORE button or craft green bar).
   * Tesseract stays off here — full name OCR runs once mode switches.
   */
  async probeIdle(): Promise<boolean> {
    if (this.active) return this.tickOnce();
    if (this.busy) return false;
    this.busy = true;
    try {
      if (!this.prepared) this.prepare();
      const signature = await loadTitleSignature();
      // cheap=true → mid/wide only (never full RS). Full locate belongs in tickOnce.
      const hit = locateRestorationTitle(signature, null, false, true);
      if (!hit) return false;
      await this.inspectUnderTitle(hit.title, true, false);
      this.cachedTitle = hit.title;
      if (!this.session && !this.pendingProgress) {
        showRestoreOutline(hit.title, "setup");
        this.setStatus({
          phase: "ready",
          message: "Restoration window detected.",
        });
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Cheap open-check — unused by companion excavate path (kept for callers).
   * Signature only; must confirm craft content before reporting open.
   */
  async probeOpen(): Promise<boolean> {
    return this.probeIdle();
  }

  /**
   * One restore pass. Returns true only when the RESTORATION window is
   * confirmed (artefact and/or N/M), not on a bare gold/button false hit.
   */
  async tickOnce(): Promise<boolean> {
    if (this.busy) return this.active;
    this.busy = true;
    try {
      if (!this.prepared) this.prepare();

      const signature = await loadTitleSignature();
      if (!signature) {
        this.setStatus({
          phase: "idle",
          message: "Restore: title signature failed to load",
        });
      }

      // Cold locate — never lock mode on outline alone (dig-site gold FPs).
      if (!this.cachedTitle && !this.session) {
        const hit = locateRestorationTitle(signature, null, true);
        if (!hit) {
          this.setStatus({
            phase: "idle",
            message: signature
              ? "Looking for restoration…"
              : "Restore: no signature — OCR looking…",
          });
          return false;
        }
        this.nameRetryAt = 0;
        // Detector already confirmed RESTORE button or craft green bar.
        await this.inspectUnderTitle(hit.title, true, true);
        this.cachedTitle = hit.title;
        if (!this.session && !this.pendingProgress) {
          showRestoreOutline(hit.title, "setup");
          this.setStatus({
            phase: "ready",
            message: "Restoration window detected.",
          });
        }
        return true;
      }

      // Window was open: confirm title still there, then OCR only if so.
      const hit = locateRestorationTitle(
        signature,
        this.cachedTitle,
        true,
      );

      if (!hit) {
        this.leaveRestore();
        return false;
      }

      this.cachedTitle = hit.title;

      if (this.session) {
        this.watchProgress(hit.title);
        return true;
      }

      const now = Date.now();
      const readName = now >= this.nameRetryAt;
      if (readName) this.nameRetryAt = now + 750;
      await this.inspectUnderTitle(hit.title, readName, true);
      if (this.session || this.pendingProgress) return true;

      // Setup / craft still open (name OCR may lag) — keep mode while locate hits.
      showRestoreOutline(hit.title, "setup");
      this.setStatus({
        phase: "ready",
        message: "Restoration window detected.",
      });
      return true;
    } finally {
      this.busy = false;
    }
  }

  private leaveRestore(): void {
    if (!this.cachedTitle && !this.session && this.status.phase === "idle") {
      return;
    }
    clearRestoreOutline();
    this.cachedTitle = null;
    this.session = null;
    this.pendingProgress = null;
    this.setStatus({ phase: "idle", message: "Not restoring" });
  }

  /** Progress-only path while a known artefact is being restored. */
  private watchProgress(title: TitleHit): void {
    const session = this.session;
    if (!session) return;

    const centerX = title.x + Math.floor(title.width / 2);
    const left = Math.max(0, centerX - 170);
    const top = Math.max(0, title.y - 6);
    const width = 340;
    const height = 200;

    // Prefer offline-proven green-bar ink on a plain capture; bind OCR as backup.
    let progress: { n: number; m: number; raw: string } | null = null;
    const roi = captureRegion(left, top, width, height);
    if (roi) progress = readProgressSparse(roi);
    progress ??= bindReadProgress(left, top, width, height);

    if (progress) {
      showRestoreOutline(title, "craft");
      session.titleAt = title;
      this.applyProgress(session, progress.n, progress.m, progress.raw);
      return;
    }

    // No N/M this frame — keep setup/craft outline from last known phase.
    showRestoreOutline(
      title,
      this.status.phase === "restoring" ? "craft" : "setup",
    );
    this.setStatus({
      phase: this.status.phase === "restoring" ? "restoring" : "ready",
      artefactName: session.artefact.name,
      planned: session.plannedM,
      progress: this.status.progress,
      message:
        this.status.phase === "restoring"
          ? `Restoring ${session.artefact.name}…`
          : `Ready: ${session.artefact.name}`,
    });
  }

  private async inspectUnderTitle(
    title: TitleHit,
    readName: boolean,
    allowTesseract = true,
  ): Promise<void> {
    const centerX = title.x + Math.floor(title.width / 2);
    const craftLeft = Math.max(0, centerX - 170);
    const craftTop = Math.max(0, title.y - 6);
    const craftW = 340;
    const craftH = 200;

    const craftRoi = captureRegion(craftLeft, craftTop, craftW, craftH);
    if (!craftRoi) {
      // Don't outline the world on a failed capture.
      return;
    }

    // Ink reader first (proven offline), then Alt1 bind OCR.
    const progress =
      readProgressSparse(craftRoi) ??
      bindReadProgress(craftLeft, craftTop, craftW, craftH);

    let artefact = this.session?.artefact ?? null;
    if (readName && !artefact) {
      artefact =
        readArtefactSparse(craftRoi) ??
        bindReadArtefact(craftLeft, craftTop, craftW, craftH);
      if (!artefact) {
        // One wider setup-pane attempt (still only while window is open).
        const setupLeft = Math.max(0, centerX - 40);
        const setupTop = Math.max(0, title.y - 8);
        artefact =
          bindReadArtefact(setupLeft, setupTop, 400, 300) ??
          (() => {
            const setupRoi = captureRegion(setupLeft, setupTop, 400, 300);
            return setupRoi ? readArtefactSparse(setupRoi) : null;
          })();
      }
      // Offline-proven fallback: tesseract on the white name band.
      // Skipped on dig-safe probes — it blocks the companion tick for seconds.
      if (!artefact && allowTesseract) {
        try {
          const { readCraftArtefactTesseract } = await import("./craft-tesseract");
          artefact = await readCraftArtefactTesseract(craftRoi);
        } catch {
          // tesseract unavailable
        }
      }
    }

    if (progress && artefact) {
      if (!this.session || this.session.artefact.id !== artefact.id) {
        this.session = {
          artefact,
          lastN: 0,
          plannedM: progress.m,
          titleAt: title,
        };
      } else {
        this.session.titleAt = title;
        this.session.plannedM = progress.m;
      }
      showRestoreOutline(title, "craft");
      this.applyProgress(this.session, progress.n, progress.m, progress.raw);
      return;
    }

    if (progress && this.session) {
      this.session.titleAt = title;
      showRestoreOutline(title, "craft");
      this.applyProgress(this.session, progress.n, progress.m, progress.raw);
      return;
    }

    if (artefact) {
      const progressNow = progress ?? this.pendingProgress;
      const planned =
        this.session?.plannedM ?? progressNow?.m ?? 1;
      this.session = {
        artefact,
        lastN:
          this.session?.artefact.id === artefact.id ? this.session.lastN : 0,
        plannedM: planned,
        titleAt: title,
      };
      if (progressNow) {
        this.pendingProgress = null;
        showRestoreOutline(title, "craft");
        this.applyProgress(
          this.session,
          progressNow.n,
          progressNow.m,
          progressNow.raw,
        );
        return;
      }
      showRestoreOutline(title, "setup");
      this.setStatus({
        phase: "ready",
        artefactName: artefact.name,
        planned,
        message: `Ready: ${artefact.name}`,
      });
      return;
    }

    if (progress) {
      // Remember N/M until the artefact name resolves, then credit the delta.
      this.pendingProgress = progress;
      showRestoreOutline(title, "craft");
      this.setStatus({
        phase: "restoring",
        progress: `${progress.n}/${progress.m}`,
        message: `Restoring · ${progress.n}/${progress.m}`,
      });
      return;
    }

    // Gold chrome without craft content — not a confirmed window.
  }

  private applyProgress(
    session: Session,
    n: number,
    m: number,
    raw: string,
  ): void {
    session.plannedM = m;
    const delta = n - session.lastN;
    if (delta > 0) {
      session.lastN = n;
      this.onRestore({
        type: "restored",
        artefact: session.artefact,
        quantity: delta,
        progress: raw,
      });
    } else if (n < session.lastN) {
      session.lastN = n;
    }

    this.setStatus({
      phase: "restoring",
      artefactName: session.artefact.name,
      progress: raw,
      planned: m,
      message: `Restoring · ${session.artefact.name} ${raw}`,
    });
  }
}
