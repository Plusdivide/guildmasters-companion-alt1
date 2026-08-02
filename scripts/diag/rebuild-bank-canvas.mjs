/**
 * Offline bank audit of Arch reference/storage-stitch_Bank.png
 * → Canvas focused on materials + artefacts only (other bank junk ignored).
 *
 *   node --experimental-strip-types scripts/diag/rebuild-bank-canvas.mjs [stitch.png]
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "../lib/png.mjs";
import { prepareSprite } from "../../src/matcher.ts";
import { matchBankStorageStitch } from "../../src/bank-stitch-match.ts";

const root = path.resolve(import.meta.dirname, "../..");
const capturePath =
  process.argv[2] ??
  path.join("W:/005 Dev/03 Alt1 Custom Apps/Arch reference", "storage-stitch_Bank.png");
const spriteRoot = path.join(root, "public/sprites");
const framedRoot = path.join(root, "public/sprites-framed");
const matchRoot = fs.existsSync(framedRoot) ? framedRoot : spriteRoot;
const canvasPath =
  "C:/Users/luke_/.cursor/projects/w-005-Dev-03-Alt1-Custom-Apps-rs3-archaeology-companion/canvases/bank-storage-scan.canvas.tsx";
const auditOut = path.join(root, "scripts/diag/audit-bank.png");

const toImage = ({ width, height, data }) => ({
  width,
  height,
  data: new Uint8ClampedArray(data),
});
const screen = toImage(decodePng(fs.readFileSync(capturePath)));

const isArchaeologyFile = (file) => {
  if (file.startsWith("mat-")) {
    const id = file.replace(/^mat-/, "").replace(/\.png$/, "");
    // Shop items (ink, gems, bars, clay…) are excluded from archaeology tracking.
    const skip = new Set([
      "black-mushroom-ink", "grapes", "soft-clay", "bronze-bar", "silver-bar",
      "diamond", "ruby", "sapphire", "emerald", "dragonstone", "molten-glass",
      "rope", "clockwork", "phoenix-feather", "death-rune", "white-candle",
      "weapon-poison-3",
    ]);
    return !skip.has(id);
  }
  return file.includes("-damaged") || file.includes("-restored");
};

const targets = [];
for (const file of fs.readdirSync(matchRoot).filter((f) => f.endsWith(".png") && isArchaeologyFile(f))) {
  const buf = decodePng(fs.readFileSync(path.join(matchRoot, file)));
  const image = toImage(buf);
  const fit = prepareSprite(image);
  if (fit) targets.push({ name: file.replace(/\.png$/, ""), fit, image, ref: file });
}
console.log(
  `capture ${screen.width}x${screen.height}   archaeology sprites ${targets.length}  (${path.basename(matchRoot)})`,
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
  const fit = prepareSprite(toImage(decodePng(fs.readFileSync(full))));
  if (fit) blankSprites.push(fit);
}

const t0 = Date.now();
const matched = await matchBankStorageStitch(
  screen,
  targets,
  (checked, total) => {
    if (checked % 40 === 0 || checked === total) {
      process.stdout.write(`\rsoft-locate ${checked}/${total}`);
    }
  },
  { blankSprites },
);
process.stdout.write("\n");
console.log(
  `lattice ${matched.columns.length}×${matched.rows.length}  pitch ${matched.latticeX.pitch.toFixed(2)}×${matched.latticeY.pitch.toFixed(2)}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);

const nameOf = (target) => {
  if (!target) return null;
  const hit = targets.find((t) => t === target || t.ref === target.ref);
  return hit?.name ?? null;
};

const shortName = (name) =>
  name
    .replace(/^mat-/, "")
    .replace(/-damaged$/, " (dmg)")
    .replace(/-restored$/, "");

const cellAt = (x, y) => ({
  c: matched.columns.findIndex((cx) => Math.abs(cx - x) < 2),
  r: matched.rows.findIndex((cy) => Math.abs(cy - y) < 2),
});

const claimed = matched.claims.map((e) => {
  const { r, c } = cellAt(e.centreX, e.centreY);
  const name = nameOf(e.target);
  return {
    r,
    c,
    centreX: e.centreX,
    centreY: e.centreY,
    name,
    short: shortName(name),
    isMat: name.startsWith("mat-"),
    exact: e.exact,
    precision: e.precision,
  };
});

const misses = [];
const ignored = [];
for (const b of matched.blanks ?? []) {
  const { r, c } = cellAt(b.x, b.y);
  ignored.push({
    r,
    c,
    centreX: b.x,
    centreY: b.y,
    guess: null,
    short: "tetra/other",
    precision: 0,
    recall: 0,
  });
}
// Bank is open-set: anything we did not claim is ignored (junk, tetra, lore
// books, …) — not an “archaeology miss”. Soft false-nearest guesses are common.
for (const u of matched.unresolved) {
  const { r, c } = cellAt(u.x, u.y);
  const guess = nameOf(u.guess);
  ignored.push({
    r,
    c,
    centreX: u.x,
    centreY: u.y,
    guess,
    short: guess ? shortName(guess) : "—",
    precision: u.precision,
    recall: u.recall,
  });
}

const blanks = [];
const occupiedKeys = new Set(
  [...claimed, ...misses, ...ignored].map((e) => `${e.r},${e.c}`),
);
for (let r = 0; r < matched.rows.length; r += 1) {
  for (let c = 0; c < matched.columns.length; c += 1) {
    if (!occupiedKeys.has(`${r},${c}`)) blanks.push({ r, c });
  }
}

const matClaims = claimed.filter((e) => e.isMat);
const artClaims = claimed.filter((e) => !e.isMat);
const exact = claimed.filter((e) => e.exact).length;
console.log(
  `CLAIMED ${claimed.length}  materials ${matClaims.length}  artefacts ${artClaims.length}  (exact ${exact})`,
);
console.log(
  `misses ${misses.length} · ignored ${ignored.length} (incl. tetra blanks ${(matched.blanks ?? []).length}) · empty ${blanks.length}`,
);

const SLOT = matched.slotSize;
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
for (const e of claimed) box(e.centreX, e.centreY, e.isMat ? [60, 180, 220] : [40, 200, 80]);
for (const e of misses) box(e.centreX, e.centreY, [220, 50, 50]);
// Ignored: no box — not archaeology
fs.writeFileSync(auditOut, encodePng(out));
console.log("wrote", auditOut);

const cellRows = claimed
  .sort((a, b) => a.r - b.r || a.c - b.c)
  .map(
    (e) =>
      `  { row: ${e.r}, column: ${e.c}, name: ${JSON.stringify(e.short)}, kind: ${JSON.stringify(e.isMat ? "material" : "artefact")}, verdict: ${JSON.stringify(e.exact ? "exact" : "redrawn")}, precision: ${Math.round(e.precision * 100)}, recall: 0 },`,
  )
  .join("\n");

const missRows = misses
  .map(
    (e) =>
      `  { row: ${e.r}, column: ${e.c}, name: ${JSON.stringify(e.short)}, kind: "miss", verdict: "miss", precision: ${Math.round(e.precision * 100)}, recall: ${Math.round(e.recall * 100)} },`,
  )
  .join("\n");

const ignoreRows = ignored
  .map(
    (e) =>
      `  { row: ${e.r}, column: ${e.c}, name: "other", kind: "ignored", verdict: "ignored", precision: ${Math.round(e.precision * 100)}, recall: ${Math.round(e.recall * 100)} },`,
  )
  .join("\n");

const blankRows = blanks
  .map(
    (b) =>
      `  { row: ${b.r}, column: ${b.c}, name: "empty", kind: "empty", verdict: "blank", precision: 0, recall: 0 },`,
  )
  .join("\n");

const spriteNames = new Set(claimed.map((e) => e.name).concat(misses.map((e) => e.guess).filter(Boolean)));
const spriteEntries = [...spriteNames]
  .map((name) => {
    const file = path.join(framedRoot, `${name}.png`);
    const fallback = path.join(spriteRoot, `${name}.png`);
    const use = fs.existsSync(file) ? file : fallback;
    if (!fs.existsSync(use)) return null;
    const b64 = fs.readFileSync(use).toString("base64");
    return `  ${JSON.stringify(shortName(name))}: "data:image/png;base64,${b64}",`;
  })
  .filter(Boolean)
  .join("\n");

const stitchB64 = fs.readFileSync(capturePath).toString("base64");
const auditB64 = fs.readFileSync(auditOut).toString("base64");
const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
const sourceName = path.basename(capturePath);
const archaeologyOk = misses.length === 0;

const src = `import {
  Callout,
  Grid,
  H1,
  H2,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

type Verdict = "exact" | "redrawn" | "miss" | "ignored" | "blank";
type Kind = "material" | "artefact" | "miss" | "ignored" | "empty";

interface Cell {
  row: number;
  column: number;
  name: string;
  kind: Kind;
  verdict: Verdict;
  precision: number;
  recall: number;
}

const CELLS: Cell[] = [
${cellRows}
${missRows}
${ignoreRows}
${blankRows}
];

const ROWS = ${matched.rows.length};
const COLUMNS = ${matched.columns.length};

const STITCH = "data:image/png;base64,${stitchB64}";
const AUDIT = "data:image/png;base64,${auditB64}";

const SPRITES: Record<string, string> = {
${spriteEntries}
};

const readable = (name: string): string => name.replace(/-/g, " ");
const materials = CELLS.filter((c) => c.kind === "material");
const artefacts = CELLS.filter((c) => c.kind === "artefact");
const misses = CELLS.filter((c) => c.kind === "miss");
const ignored = CELLS.filter((c) => c.kind === "ignored");
const claimed = [...materials, ...artefacts];
const exactCount = claimed.filter((c) => c.verdict === "exact").length;

function SlotGrid() {
  const theme = useHostTheme();
  const byPosition = new Map(CELLS.map((cell) => [\`\${cell.row},\${cell.column}\`, cell]));
  const tiles = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const cell = byPosition.get(\`\${row},\${column}\`);
      if (!cell || cell.kind === "empty") {
        tiles.push(
          <div
            key={\`\${row},\${column}\`}
            title={\`r\${row + 1} c\${column + 1} — empty\`}
            style={{
              width: 42,
              height: 36,
              border: \`1px dashed \${theme.stroke.tertiary}\`,
              opacity: 0.35,
            }}
          />,
        );
        continue;
      }
      if (cell.kind === "ignored") {
        tiles.push(
          <div
            key={\`\${row},\${column}\`}
            title={\`r\${row + 1} c\${column + 1} — ignored (not a material/artefact)\`}
            style={{
              width: 42,
              height: 36,
              border: \`1px solid \${theme.stroke.tertiary}\`,
              opacity: 0.25,
            }}
          />,
        );
        continue;
      }
      if (cell.kind === "miss") {
        tiles.push(
          <div
            key={\`\${row},\${column}\`}
            title={\`r\${row + 1} c\${column + 1} — missed \${readable(cell.name)} (p\${cell.precision}% r\${cell.recall}%)\`}
            style={{
              width: 42,
              height: 36,
              background: theme.fill.tertiary,
              border: \`1px solid \${theme.category.red}\`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {SPRITES[cell.name] ? (
              <img
                src={SPRITES[cell.name]}
                alt={readable(cell.name)}
                style={{ width: 32, height: 32, objectFit: "contain", imageRendering: "pixelated", opacity: 0.55 }}
              />
            ) : (
              <Text size="small" tone="primary">!</Text>
            )}
          </div>,
        );
        continue;
      }
      const border =
        cell.kind === "material"
          ? theme.category.cyan
          : cell.verdict === "redrawn"
            ? theme.accent.primary
            : theme.stroke.tertiary;
      tiles.push(
        <div
          key={\`\${row},\${column}\`}
          title={\`r\${row + 1} c\${column + 1} — \${readable(cell.name)} (\${cell.kind}, \${cell.verdict}, p\${cell.precision}%)\`}
          style={{
            width: 42,
            height: 36,
            background: theme.fill.tertiary,
            border: \`1px solid \${border}\`,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {SPRITES[cell.name] ? (
            <img
              src={SPRITES[cell.name]}
              alt={readable(cell.name)}
              style={{ width: 32, height: 32, objectFit: "contain", imageRendering: "pixelated" }}
            />
          ) : (
            <Text size="small" tone="primary">!</Text>
          )}
        </div>,
      );
    }
  }
  return (
    <Grid columns={\`repeat(\${COLUMNS}, 42px)\`} gap={0} style={{ justifyContent: "start" }}>
      {tiles}
    </Grid>
  );
}

export default function BankStorageScan() {
  const theme = useHostTheme();
  return (
    <Stack gap={20} style={{ padding: 20 }}>
      <Stack gap={4}>
        <H1>Bank — materials & artefacts</H1>
        <Text size="small" tone="tertiary">
          Source: ${sourceName} (${screen.width}×${screen.height}) · archaeology sprites only · ${stamp}
        </Text>
      </Stack>

      ${
        archaeologyOk
          ? `<Callout tone="success" title="All detectable archaeology claimed">
        ${claimed.length} materials/artefacts matched. ${ignored.length} other bank slots ignored (not in the archaeology sprite set).
      </Callout>`
          : `<Callout tone="danger" title="${misses.length} archaeology miss${misses.length === 1 ? "" : "es"}">
        Occupied slots whose nearest material/artefact sprite is strong but was not claimed. Red on the audit.
      </Callout>`
      }

      <Grid columns={5} gap={12}>
        <Stat value="${matClaims.length}" label="Materials" tone="info" />
        <Stat value="${artClaims.length}" label="Artefacts" tone="success" />
        <Stat value="${exact}" label="Exact" />
        <Stat value="${misses.length}" label="Misses" tone={${misses.length ? '"danger"' : '"success"'}} />
        <Stat value="${ignored.length}" label="Ignored other" />
      </Grid>

      <Stack gap={8}>
        <H2>Stitch vs audit</H2>
        <Text size="small" tone="secondary">
          Cyan = material · green = artefact · red = archaeology miss · no box = ignored non-archaeology.
        </Text>
        <Grid columns="repeat(2, minmax(200px, max-content))" gap={24}>
          <Stack gap={6}>
            <Text size="small" weight="semibold">Bank stitch</Text>
            <img
              src={STITCH}
              alt="Bank stitch"
              style={{
                width: ${screen.width},
                height: ${screen.height},
                imageRendering: "pixelated",
                display: "block",
                border: \`1px solid \${theme.stroke.tertiary}\`,
              }}
            />
          </Stack>
          <Stack gap={6}>
            <Text size="small" weight="semibold">Audit overlay</Text>
            <img
              src={AUDIT}
              alt="Audit"
              style={{
                width: ${screen.width},
                height: ${screen.height},
                imageRendering: "pixelated",
                display: "block",
                border: \`1px solid \${theme.stroke.tertiary}\`,
              }}
            />
          </Stack>
        </Grid>
      </Stack>

      <Stack gap={8}>
        <H2>Slot grid (${matched.columns.length}×${matched.rows.length})</H2>
        <SlotGrid />
      </Stack>

      {misses.length > 0 ? (
        <Stack gap={8}>
          <H2>Archaeology misses</H2>
          <Table
            headers={["Row", "Col", "Nearest", "P%", "R%"]}
            rows={misses
              .sort((a, b) => a.row - b.row || a.column - b.column)
              .map((c) => [
                String(c.row + 1),
                String(c.column + 1),
                readable(c.name),
                String(c.precision),
                String(c.recall),
              ])}
          />
        </Stack>
      ) : null}

      <Stack gap={8}>
        <H2>Claimed materials (${matClaims.length})</H2>
        <Table
          headers={["Row", "Col", "Material", "P%", "How"]}
          rows={materials
            .sort((a, b) => a.row - b.row || a.column - b.column)
            .map((c) => [
              String(c.row + 1),
              String(c.column + 1),
              readable(c.name),
              String(c.precision),
              c.verdict,
            ])}
        />
      </Stack>

      <Stack gap={8}>
        <H2>Claimed artefacts (${artClaims.length})</H2>
        <Table
          headers={["Row", "Col", "Artefact", "P%", "How"]}
          rows={artefacts
            .sort((a, b) => a.row - b.row || a.column - b.column)
            .map((c) => [
              String(c.row + 1),
              String(c.column + 1),
              readable(c.name),
              String(c.precision),
              c.verdict,
            ])}
        />
      </Stack>

      <Row gap={8}>
        <Text size="small" tone="tertiary">
          Pitch ${matched.latticeX.pitch.toFixed(2)}×${matched.latticeY.pitch.toFixed(2)} · exact {exactCount} · ignored bank junk {ignored.length}
        </Text>
      </Row>
    </Stack>
  );
}
`;

fs.writeFileSync(canvasPath, src);
console.log("wrote", canvasPath);
