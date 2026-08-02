/**
 * Offline materials audit → Cursor canvas.
 * Matching is the live module (src/material-stitch-match.ts) — one implementation.
 *
 *   node --experimental-strip-types scripts/diag/rebuild-materials-canvas.mjs [stitch.png]
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "../lib/png.mjs";
import { prepareSprite } from "../../src/matcher.ts";
import { matchMaterialStorageStitch } from "../../src/material-stitch-match.ts";

const root = path.resolve(import.meta.dirname, "../..");
const capturePath =
  process.argv[2] ??
  path.join("W:/005 Dev/03 Alt1 Custom Apps/Arch reference", "storage-stitch_Materials.png");
const spriteRoot = path.join(root, "public/sprites");
const framedRoot = path.join(root, "public/sprites-framed");
const matchRoot = fs.existsSync(framedRoot) ? framedRoot : spriteRoot;
const padlockPath = path.join(root, "public/ui/slot-padlock.png");
const canvasPath =
  "C:/Users/luke_/.cursor/projects/w-005-Dev-03-Alt1-Custom-Apps-rs3-archaeology-companion/canvases/materials-storage-scan.canvas.tsx";
const auditOut = path.join(root, "scripts/diag/audit-materials.png");

const toImage = ({ width, height, data }) => ({
  width,
  height,
  data: new Uint8ClampedArray(data),
});
const screen = toImage(decodePng(fs.readFileSync(capturePath)));
const padlock = prepareSprite(toImage(decodePng(fs.readFileSync(padlockPath))));

const targets = [];
for (const file of fs.readdirSync(matchRoot).filter((f) => f.startsWith("mat-") && f.endsWith(".png"))) {
  const image = toImage(decodePng(fs.readFileSync(path.join(matchRoot, file))));
  const fit = prepareSprite(image);
  const name = file.replace(/\.png$/, "");
  if (fit) targets.push({ name, fit, image, ref: name });
}
console.log(
  `capture ${screen.width}x${screen.height}   materials ${targets.length}  (${path.basename(matchRoot)})`,
);

const matched = await matchMaterialStorageStitch(screen, targets, padlock);
const SLOT = matched.slotSize;
const claimed = matched.claims;
const missed = matched.unresolved;
const blanks = matched.blanks;
const exact = claimed.filter((e) => e.exact).length;
const lockBlanks = blanks.filter((b) => b.kind === "lock").length;
const emptyBlanks = blanks.filter((b) => b.kind === "empty").length;
const occupied = claimed.length + missed.length;

console.log(
  `CLAIMED ${claimed.length} of ${occupied} occupied  (exact ${exact}, redrawn ${claimed.length - exact})`,
);
console.log(`blanks: ${lockBlanks} locks · ${emptyBlanks} empty · unclaimed ${missed.length}`);
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
for (const b of blanks.filter((x) => x.kind === "lock")) box(b.x, b.y, [180, 160, 80]);
fs.writeFileSync(auditOut, encodePng(out));
console.log("wrote", auditOut);

const shortName = (name) => String(name).replace(/^mat-/, "");
const targetName = (target) => shortName(target?.name ?? target?.ref ?? "?");

const cellRows = [...claimed]
  .sort((a, b) => a.row - b.row || a.column - b.column)
  .map(
    (e) =>
      `  { row: ${e.row}, column: ${e.column}, name: ${JSON.stringify(targetName(e.target))}, kind: "claimed", verdict: ${JSON.stringify(e.exact ? "exact" : "redrawn")}, precision: ${Math.round(e.precision * 100)}, recall: ${Math.round(e.recall * 100)} },`,
  )
  .join("\n");

const missRows = missed
  .map((cell) => {
    const near = cell.guess;
    return `  { row: ${cell.row}, column: ${cell.column}, name: ${JSON.stringify(near ? targetName(near) : "unclaimed")}, kind: "miss", verdict: "miss", precision: ${Math.round(cell.precision * 100)}, recall: ${Math.round(cell.recall * 100)} },`;
  })
  .join("\n");

const blankRows = blanks
  .map(
    (b) =>
      `  { row: ${b.row}, column: ${b.column}, name: ${JSON.stringify(b.kind === "lock" ? "locked-slot" : "empty")}, kind: ${JSON.stringify(b.kind)}, verdict: "blank", precision: 0, recall: 0 },`,
  )
  .join("\n");

const spriteNames = new Set(
  claimed.map((e) => e.target.name ?? String(e.target.ref ?? "")).filter(Boolean),
);
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

const lockB64 = fs.existsSync(path.join(root, "public/ui/slot-padlock-cell.png"))
  ? fs.readFileSync(path.join(root, "public/ui/slot-padlock-cell.png")).toString("base64")
  : fs.readFileSync(padlockPath).toString("base64");

const stitchB64 = fs.readFileSync(capturePath).toString("base64");
const auditB64 = fs.readFileSync(auditOut).toString("base64");
const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
const sourceName = path.basename(capturePath);

// Keep the previous canvas template by regenerating from a slim stub file if present,
// otherwise write a minimal report canvas.
const prev = fs.existsSync(canvasPath) ? fs.readFileSync(canvasPath, "utf8") : "";
const gridCols = matched.columns.length;
const gridRows = matched.rows.length;

const src = `import {
  Callout,
  Grid,
  H1,
  H2,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

type Verdict = "exact" | "redrawn" | "miss" | "blank";

interface Cell {
  row: number;
  column: number;
  name: string;
  kind: string;
  verdict: Verdict;
  precision: number;
  recall: number;
}

const SPRITES: Record<string, string> = {
${spriteEntries}
  "locked-slot": "data:image/png;base64,${lockB64}",
};

const STITCH = "data:image/png;base64,${stitchB64}";
const AUDIT = "data:image/png;base64,${auditB64}";

const CELLS: Cell[] = [
${cellRows}
${missRows}
${blankRows}
];

const toneOf = (v: Verdict) =>
  v === "exact" ? "success" : v === "redrawn" ? "warning" : v === "miss" ? "danger" : "neutral";

export default function MaterialsStorageScan() {
  const theme = useHostTheme();
  const claimed = CELLS.filter((c) => c.kind === "claimed");
  const locks = CELLS.filter((c) => c.kind === "lock");
  const misses = CELLS.filter((c) => c.kind === "miss");

  return (
    <Stack gap={20} style={{ padding: 20, maxWidth: 1100 }}>
      <H1>Material Storage — offline = live matcher</H1>
      <Text tone="secondary">
        Source: ${sourceName} (${screen.width}×${screen.height}) · closed-set materials · padlocks as blanks · ${stamp}
      </Text>
      <Callout tone={misses.length === 0 ? "success" : "danger"}>
        {claimed.length} materials claimed, {locks.length} locked slots blanked, ${emptyBlanks} empty.
        {misses.length === 0 ? " No unmatched occupied cells." : \` \${misses.length} unmatched.\`}
      </Callout>
      <Row gap={16}>
        <Stat value="${claimed.length}" label="Claimed" />
        <Stat value="${exact}" label="Exact" />
        <Stat value="${claimed.length - exact}" label="Redrawn" />
        <Stat value="${lockBlanks}" label="Locked blanks" />
        <Stat value="${missed.length}" label="Unclaimed" />
      </Row>
      <H2>Stitch + audit overlay</H2>
      <Row gap={12} style={{ alignItems: "flex-start" }}>
        <img src={STITCH} alt="stitch" style={{ maxWidth: "48%", borderRadius: 6 }} />
        <img src={AUDIT} alt="audit" style={{ maxWidth: "48%", borderRadius: 6 }} />
      </Row>
      <Text tone="secondary">
        Green = claimed · gold = locked blank · red = unclaimed occupied. Matcher: src/material-stitch-match.ts
      </Text>
      <H2>Grid (${gridCols}×${gridRows})</H2>
      <Grid columns={${gridCols}} gap={6}>
        {Array.from({ length: ${gridRows} * ${gridCols} }, (_, i) => {
          const row = Math.floor(i / ${gridCols});
          const column = i % ${gridCols};
          const cell = CELLS.find((c) => c.row === row && c.column === column);
          if (!cell) return <div key={i} />;
          const srcImg =
            cell.kind === "lock"
              ? SPRITES["locked-slot"]
              : cell.kind === "empty"
                ? undefined
                : SPRITES[cell.name];
          return (
            <Stack
              key={i}
              gap={4}
              style={{
                padding: 6,
                borderRadius: 6,
                background: theme.background.secondary,
                outline: cell.verdict === "miss" ? "2px solid #c44" : undefined,
              }}
            >
              {srcImg ? (
                <img src={srcImg} alt={cell.name} width={32} height={32} />
              ) : (
                <div style={{ width: 32, height: 32 }} />
              )}
              <Pill tone={toneOf(cell.verdict)}>{cell.verdict}</Pill>
              <Text size="small">{cell.name}</Text>
            </Stack>
          );
        })}
      </Grid>
      <H2>Claims</H2>
      <Table
        headers={["Cell", "Name", "Verdict", "P%", "R%"]}
        rows={claimed
          .sort((a, b) => a.row - b.row || a.column - b.column)
          .map((c) => [
            \`r\${c.row + 1} c\${c.column + 1}\`,
            c.name,
            c.verdict,
            String(c.precision),
            String(c.recall),
          ])}
      />
    </Stack>
  );
}
`;

fs.writeFileSync(canvasPath, src);
console.log("wrote", canvasPath);
if (prev && prev.length > 100) {
  console.log("(replaced previous canvas; matching now uses src/material-stitch-match.ts)");
}
