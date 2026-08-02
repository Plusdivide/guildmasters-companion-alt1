/**
 * Rebuild a single canvas covering bank, material-storage, and workbench
 * offline-parity reports (same matchers the live stitch path uses).
 *
 *   node --experimental-strip-types scripts/diag/rebuild-parity-canvas.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "../lib/png.mjs";
import { prepareSprite } from "../../src/matcher.ts";
import { matchBankStorageStitch } from "../../src/bank-stitch-match.ts";
import { matchMaterialStorageStitch } from "../../src/material-stitch-match.ts";
import { matchWorkbenchStorageStitch } from "../../src/workbench-stitch-match.ts";

const root = path.resolve(import.meta.dirname, "../..");
const ref = "W:/005 Dev/03 Alt1 Custom Apps/Arch reference";
const matchRoot = path.join(root, "public/sprites-framed");
const canvasPath =
  "C:/Users/luke_/.cursor/projects/w-005-Dev-03-Alt1-Custom-Apps-rs3-archaeology-companion/canvases/storage-scan-parity.canvas.tsx";
const outDir = path.join(root, "scripts/diag");

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

const paintBox = (out, cx, cy, rgb, half = 16) => {
  const [r, g, b] = rgb;
  for (let y = Math.round(cy - half); y <= Math.round(cy + half); y += 1) {
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x += 1) {
      if (x < 0 || y < 0 || x >= out.width || y >= out.height) continue;
      const edge =
        x === Math.round(cx - half) ||
        x === Math.round(cx + half) ||
        y === Math.round(cy - half) ||
        y === Math.round(cy + half);
      if (!edge) continue;
      const i = (y * out.width + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
};

const cloneScreen = (screen) => ({
  width: screen.width,
  height: screen.height,
  data: new Uint8ClampedArray(screen.data),
});

/* ---------- BANK ---------- */
const bankScreen = loadPng(path.join(ref, "storage-stitch_Bank.png"));
const bankTargets = loadTargets(
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
const bank = await matchBankStorageStitch(bankScreen, bankTargets, undefined, { blankSprites });
const bankOut = cloneScreen(bankScreen);
for (const c of bank.claims) {
  const n = nameOf(bankTargets, c);
  paintBox(bankOut, c.centreX, c.centreY, n.startsWith("mat-") ? [60, 180, 220] : [40, 200, 80]);
}
for (const u of bank.unresolved) paintBox(bankOut, u.x, u.y, [80, 80, 80]);
for (const b of bank.blanks) paintBox(bankOut, b.x, b.y, [180, 160, 60]);
const bankAuditPath = path.join(outDir, "audit-bank.png");
fs.writeFileSync(bankAuditPath, encodePng(bankOut));
const bankMats = bank.claims.filter((c) => nameOf(bankTargets, c).startsWith("mat-")).length;
const bankArts = bank.claims.length - bankMats;
const bankExact = bank.claims.filter((c) => c.exact).length;
console.log(`BANK ${bank.claims.length} claims (${bankMats} mat / ${bankArts} art)`);

/* ---------- MATERIALS ---------- */
const matScreen = loadPng(path.join(ref, "storage-stitch_Materials.png"));
const matTargets = loadTargets((file) => file.startsWith("mat-"));
const padlock = prepareSprite(loadPng(path.join(root, "public/ui/slot-padlock.png")));
const mats = await matchMaterialStorageStitch(matScreen, matTargets, padlock);
const matOut = cloneScreen(matScreen);
for (const c of mats.claims) paintBox(matOut, c.centreX, c.centreY, [40, 200, 80]);
for (const u of mats.unresolved) paintBox(matOut, u.x, u.y, [200, 60, 50]);
const matAuditPath = path.join(outDir, "audit-materials.png");
fs.writeFileSync(matAuditPath, encodePng(matOut));
const matExact = mats.claims.filter((c) => c.exact).length;
console.log(`MATERIALS ${mats.claims.length} claims · unresolved ${mats.unresolved.length}`);

/* ---------- WORKBENCH ---------- */
const full = loadPng(path.join(ref, "Workbench-Storage_Capture.PNG"));
const x0 = 29;
const y0 = 54;
const w = 212;
const h = 398;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const si = ((y0 + y) * full.width + (x0 + x)) * 4;
    data.set(full.data.subarray(si, si + 4), (y * w + x) * 4);
  }
}
const wbScreen = { width: w, height: h, data };
const wbTargets = loadTargets((file) => file.includes("-damaged"));
const wb = await matchWorkbenchStorageStitch(wbScreen, wbTargets);
const wbOut = cloneScreen(wbScreen);
const wbRows = [];
for (const c of wb.claims) {
  const name = nameOf(wbTargets, c);
  paintBox(wbOut, c.centreX, c.centreY, c.exact ? [40, 200, 80] : [80, 160, 220]);
  const col = wb.columns.findIndex((cx) => Math.abs(cx - c.centreX) < 2);
  const row = wb.rows.findIndex((cy) => Math.abs(cy - c.centreY) < 2);
  wbRows.push({
    row,
    column: col,
    name: name.replace(/-damaged$/, ""),
    verdict: c.exact ? "exact" : "redrawn",
    precision: Math.round(c.precision * 100),
  });
}
for (const u of wb.unresolved) paintBox(wbOut, u.x, u.y, [200, 60, 50]);
const wbAuditPath = path.join(outDir, "audit-workbench.png");
fs.writeFileSync(wbAuditPath, encodePng(wbOut));
const wbExact = wb.claims.filter((c) => c.exact).length;
console.log(`WORKBENCH ${wb.claims.length} claims · cols ${wb.columns.length} · unresolved ${wb.unresolved.length}`);

wbRows.sort((a, b) => a.row - b.row || a.column - b.column);

const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
const bankOk = bank.claims.length === 56;
const matOk = mats.claims.length === 40 && mats.unresolved.length === 0;
const wbOk = wb.columns.length === 5 && wb.unresolved.length === 0 && wb.claims.length >= 50;

const bankB64 = fs.readFileSync(bankAuditPath).toString("base64");
const matB64 = fs.readFileSync(matAuditPath).toString("base64");
const wbB64 = fs.readFileSync(wbAuditPath).toString("base64");

const wbTableRows = wbRows
  .map(
    (r) =>
      `  { row: ${r.row + 1}, column: ${r.column + 1}, name: ${JSON.stringify(r.name)}, verdict: ${JSON.stringify(r.verdict)}, precision: ${r.precision} },`,
  )
  .join("\n");

const src = `import {
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

const STAMP = ${JSON.stringify(stamp)};
const BANK_AUDIT = "data:image/png;base64,${bankB64}";
const MAT_AUDIT = "data:image/png;base64,${matB64}";
const WB_AUDIT = "data:image/png;base64,${wbB64}";

const BANK = {
  claims: ${bank.claims.length},
  materials: ${bankMats},
  artefacts: ${bankArts},
  exact: ${bankExact},
  unresolved: ${bank.unresolved.length},
  blanks: ${bank.blanks.length},
  cols: ${bank.columns.length},
  rows: ${bank.rows.length},
  ok: ${bankOk},
};

const MATERIALS = {
  claims: ${mats.claims.length},
  exact: ${matExact},
  unresolved: ${mats.unresolved.length},
  cols: ${mats.columns.length},
  rows: ${mats.rows.length},
  ok: ${matOk},
};

const WORKBENCH = {
  claims: ${wb.claims.length},
  exact: ${wbExact},
  redrawn: ${wb.claims.length - wbExact},
  unresolved: ${wb.unresolved.length},
  cols: ${wb.columns.length},
  rows: ${wb.rows.length},
  ok: ${wbOk},
};

const WB_CELLS = [
${wbTableRows}
];

function AuditImage({ src, label }: { src: string; label: string }) {
  const theme = useHostTheme();
  return (
    <Stack gap={6}>
      <Text size="small" weight="semibold">{label}</Text>
      <div
        style={{
          border: \`1px solid \${theme.stroke.tertiary}\`,
          background: theme.fill.tertiary,
          padding: 8,
          overflow: "auto",
          maxHeight: 360,
        }}
      >
        <img
          src={src}
          alt={label}
          style={{ display: "block", maxWidth: "100%", imageRendering: "pixelated" }}
        />
      </div>
    </Stack>
  );
}

export default function StorageScanParity() {
  return (
    <Stack gap={24} style={{ padding: 20 }}>
      <Stack gap={6}>
        <H1>Storage scan parity</H1>
        <Text size="small" tone="tertiary">
          Offline audits of the three stitch matchers used by the live app · {STAMP}
        </Text>
        <Row gap={8} wrap>
          <Pill tone={BANK.ok ? "success" : "warning"}>Bank {BANK.ok ? "OK" : "check"}</Pill>
          <Pill tone={MATERIALS.ok ? "success" : "warning"}>
            Materials {MATERIALS.ok ? "OK" : "check"}
          </Pill>
          <Pill tone={WORKBENCH.ok ? "success" : "warning"}>
            Workbench {WORKBENCH.ok ? "OK" : "check"}
          </Pill>
        </Row>
      </Stack>

      <Callout
        tone={BANK.ok && MATERIALS.ok && WORKBENCH.ok ? "success" : "warning"}
        title="Three isolated systems"
      >
        Bank uses matchBankStorageStitch (open-set). Material storage uses
        matchMaterialStorageStitch (padlocks as blanks). Workbench uses
        matchWorkbenchStorageStitch (closed-set damaged, 5 columns). Live stitch
        scans call these same modules.
      </Callout>

      <Divider />

      <Stack gap={12}>
        <H2>Bank</H2>
        <Text size="small" tone="secondary">
          Source: storage-stitch_Bank.png · open-set archaeology materials + artefacts ·
          tetra blanks ignored
        </Text>
        <Grid columns={4} gap={12}>
          <Stat
            value={\`\${BANK.claims}\`}
            label="Claimed (expect 56)"
            tone={BANK.ok ? "success" : "warning"}
          />
          <Stat value={\`\${BANK.materials} / \${BANK.artefacts}\`} label="Materials / artefacts" />
          <Stat value={\`\${BANK.exact}\`} label="Exact matches" />
          <Stat
            value={\`\${BANK.unresolved}\`}
            label={\`Unresolved · \${BANK.blanks} tetra blanks\`}
          />
        </Grid>
        <AuditImage
          src={BANK_AUDIT}
          label={\`Annotated audit · \${BANK.cols}×\${BANK.rows} lattice · green artefact · cyan material · grey ignored\`}
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>Material storage</H2>
        <Text size="small" tone="secondary">
          Source: storage-stitch_Materials.png · closed-set materials · padlocks blanked
        </Text>
        <Grid columns={4} gap={12}>
          <Stat
            value={\`\${MATERIALS.claims}\`}
            label="Claimed (expect 40)"
            tone={MATERIALS.ok ? "success" : "warning"}
          />
          <Stat value={\`\${MATERIALS.exact}\`} label="Exact matches" />
          <Stat
            value={\`\${MATERIALS.unresolved}\`}
            label="Unresolved (expect 0)"
            tone={MATERIALS.unresolved === 0 ? "success" : "danger"}
          />
          <Stat value={\`\${MATERIALS.cols}×\${MATERIALS.rows}\`} label="Lattice" />
        </Grid>
        <AuditImage
          src={MAT_AUDIT}
          label="Annotated audit · green claimed · red would be unclaimed occupied"
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>Workbench</H2>
        <Text size="small" tone="secondary">
          Source: Workbench-Storage_Capture.PNG cropped to left storage (212×398) ·
          closed-set damaged artefacts · 5 columns
        </Text>
        <Grid columns={4} gap={12}>
          <Stat
            value={\`\${WORKBENCH.claims}\`}
            label="Claimed"
            tone={WORKBENCH.ok ? "success" : "warning"}
          />
          <Stat value={\`\${WORKBENCH.exact}\`} label="Exact matches" />
          <Stat value={\`\${WORKBENCH.redrawn}\`} label="Redrawn accepts" />
          <Stat
            value={\`\${WORKBENCH.unresolved}\`}
            label={\`Unresolved · \${WORKBENCH.cols} cols\`}
            tone={WORKBENCH.unresolved === 0 ? "success" : "danger"}
          />
        </Grid>
        <AuditImage
          src={WB_AUDIT}
          label="Annotated audit · green exact · blue redrawn · red unclaimed"
        />
        <H3>Claimed slots</H3>
        <Table
          headers={["Row", "Col", "Artefact", "Verdict", "Precision %"]}
          rows={WB_CELLS.map((c) => [
            String(c.row),
            String(c.column),
            c.name.replace(/-/g, " "),
            c.verdict,
            String(c.precision),
          ])}
        />
      </Stack>
    </Stack>
  );
}
`;

fs.writeFileSync(canvasPath, src);
console.log("wrote", canvasPath, `(${(fs.statSync(canvasPath).size / 1024).toFixed(0)} KB)`);
