import "./style.css";
import {
  archaeologyData,
  archaeologyMaterials,
  artefactIcon,
  bestCollectionOpportunities,
  COMMON_MATERIALS_LABEL,
  formatNumber,
  getCollectionProgress,
  isArchaeologyMaterial,
  materialCategory,
  materialFindSites,
  materialIcon,
  tetraPieceIcon,
  tetraPieceLabel,
  uiIcon,
} from "./data";
import { fetchArchaeologyHiscore } from "./hiscores";
import {
  assembleTetraCompass,
  exportState,
  getCount,
  getMaterial,
  getTetraPiece,
  importState,
  loadState,
  resetScanWizardProgress,
  saveStateNow,
  setCount,
  setMaterial,
  setTetraPiece,
  tetraCompassesReady,
} from "./store";
import { getAlt1Status, identifyAlt1App } from "./alt1";
import { addIgnored, clearIgnored, ignoredCount } from "./ignored";
import {
  artefactLearnedKey,
  clearLearned,
  learnedCount,
  materialLearnedKey,
  parseLearnedKey,
  saveLearnedSprite,
} from "./learned";
import type { ScanHit, ScanMode, ScanResult } from "./scanner";
import {
  isHoverTeachActive,
  startCellHoverTeach,
  startHoverTeach,
  stopHoverTeach,
} from "./tooltip-teach";
import type { CompanionWatcher } from "./companion-watcher";
import { excavationSnapshot, noteExcavationValue } from "./excavation-session";
import {
  artefactRestoreCost,
  ensureMaterialPrices,
  ensurePriceForName,
  formatGp,
  getPriceVersion,
  materialPrice,
  priceForName,
} from "./prices";
import type {
  Artefact,
  Collection,
  MaterialInfo,
  PlayerState,
  ScanWizardInterface,
  TetraPieceId,
  ViewName,
} from "./types";
import { emptyTetraPieces, TETRA_PIECE_IDS } from "./types";
import {
  ENABLE_DEV_TOOLS,
  isDevToolsActive,
  setDevModeEnabled,
} from "./dev-tools";

const app = document.querySelector<HTMLDivElement>("#app")!;
let state: PlayerState = loadState();
setDevModeEnabled(state.devMode);

// Drop shop / non-dig materials left over from older saves.
{
  let pruned = false;
  for (const id of Object.keys(state.materials)) {
    const material = archaeologyData.materials.find((entry) => entry.id === id);
    if (material && !isArchaeologyMaterial(material)) {
      delete state.materials[id];
      pruned = true;
    }
  }
  if (pruned) saveStateNow(state);
}

/** True until the player finishes or skips the first-run storage scan wizard. */
const needsScanWizard = (): boolean => state.setupComplete && !state.scanWizardComplete;

const WIZARD_STEPS: ScanWizardInterface[] = ["bank", "material-storage", "workbench"];

const WIZARD_LABELS: Record<ScanWizardInterface, string> = {
  bank: "Bank",
  "material-storage": "Material Storage",
  workbench: "Workbench",
};

const WIZARD_INSTRUCTIONS: Record<ScanWizardInterface, string> = {
  bank: "Open your bank on a dedicated Archaeology tab (recommended for reliable scans). Keep the title visible, then press Start scanning.",
  "material-storage": "Open Material Storage, keep its title visible, then press Start scanning. While it runs, click the bottom scrollbar arrow in small steps so every row is captured.",
  workbench: "Open the Archaeologist’s Workbench storage, keep its title visible, then press Start scanning. While it runs, click the bottom scrollbar arrow in small steps so every row is captured.",
};

/** Session-only skips so a skipped step can be scanned later via Settings → Run scan again. */
const wizardSkipped = new Set<ScanWizardInterface>();

const nextWizardStep = (): ScanWizardInterface | null =>
  WIZARD_STEPS.find((step) => !state.scanWizardDone[step] && !wizardSkipped.has(step)) ?? null;

const wizardStepNumber = (step: ScanWizardInterface): number =>
  WIZARD_STEPS.indexOf(step) + 1;

let view: ViewName = "dashboard";
let search = "";
let materialSearch = "";
let inventorySection: "artefacts" | "materials" = "artefacts";
let collectionFilter = "all";
let toastTimer: number | undefined;
let searchTimer: number | undefined;
let lastScan: ScanResult | null = null;
let hoverTeachHint = "";
/** Debug cell waiting for a tooltip while the mouse is over that slot. */
let cellTeach: { row: number; column: number } | null = null;
/** Tooltip name captured — waiting for the user to confirm before saving. */
let pendingTeachConfirm: {
  key: string;
  label: string;
  dataUrl: string;
  row: number;
  column: number;
  trackable: boolean;
} | null = null;
let scanBusy = false;
let scanMessage = "";
let scanLive = false;
let scanStopRequested = false;
let scanPasses = 0;
let companionWatcher: CompanionWatcher | null = null;
let companionWatcherStarting = false;
/** Suppress restore-status toasts briefly after an inventory apply toast. */
let lastRestoreToastAt = 0;
/** Throttle identical artefact-popup near-miss toasts. */
let lastPopupMissToast = "";
let lastPopupMissToastAt = 0;
let excavationRateTimer: number | undefined;
let manualSetup = false;
const collapsed = new Set<string>(["overview:recommended"]);
// Alt1's CEF host suppresses window.confirm(), so destructive actions ask for a
// second click on the same button instead.
let pendingConfirm: { id: string; until: number } | null = null;

const confirmDestructive = (id: string, prompt: string): boolean => {
  const now = Date.now();
  if (pendingConfirm?.id === id && pendingConfirm.until > now) {
    pendingConfirm = null;
    return true;
  }
  pendingConfirm = { id, until: now + 4000 };
  showToast(`${prompt} Click again to confirm.`, "error");
  return false;
};

const CULTURES = [
  "Zarosian",
  "Zamorakian",
  "Saradominist",
  "Armadylean",
  "Bandosian",
  "Dragonkin",
];

const MATERIAL_CATEGORIES = [
  COMMON_MATERIALS_LABEL,
  ...CULTURES,
];

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]!);

const img = (src: string, className: string): string =>
  `<img class="${className}" src="${src}" alt="" loading="lazy" decoding="async">`;

/** Ink toast: detect=blue, good=green (gains), bad=red (losses), error=orange. */
const showToast = (
  message: string,
  kind: "detect" | "good" | "bad" | "error" = "detect",
): void => {
  document.querySelector(".toast")?.remove();
  const element = document.createElement("div");
  element.className = `toast ${kind}`;
  element.textContent = message;
  document.body.append(element);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.remove(), 3200);
};

const ownedTotal = (): number =>
  Object.values(state.inventory).reduce(
    (total, count) => total + count.damaged + count.restored, 0,
  );

const pendingXp = (): number =>
  archaeologyData.artefacts.reduce(
    (total, artefact) => total + getCount(state, artefact.id).damaged * artefact.restoreXp, 0,
  );

const progressList = () =>
  archaeologyData.collections
    .filter((collection) => collection.level <= state.level)
    .map((collection) => getCollectionProgress(collection, state));

/* ---------------------------------------------------------------- header */

const renderHeader = (): string => {
  const tabs: ViewName[] = ["dashboard", "inventory", "collections", "settings"];
  const label = (name: ViewName) => {
    if (name === "dashboard") return "Overview";
    if (name === "inventory") return "Inventory";
    return name[0].toUpperCase() + name.slice(1);
  };

  return `
  <header class="app-header">
    <div class="brand">${img(uiIcon("app-icon"), "brand-icon")}<h1>Guildmaster’s Companion</h1></div>
    ${state.setupComplete ? `
      <div class="header-actions">
        <div class="level-pill" title="${formatNumber(state.xp)} Archaeology XP">
          ${img(uiIcon("archaeology"), "skill-icon")}<strong>${state.level}</strong>
        </div>
      </div>` : ""}
  </header>
  ${state.setupComplete ? `
    <nav class="tabs" aria-label="Main navigation">
      ${tabs.map((name) =>
        `<button class="${view === name ? "active" : ""}" data-view="${name}">${label(name)}</button>`,
      ).join("")}
    </nav>` : ""}`;
};

/* ----------------------------------------------------------------- setup */

const passLabel = (count: number): string =>
  `${count} pass${count === 1 ? "" : "es"}`;

const renderSetupBrand = (subtitle?: string): string => `
  <div class="setup-brand">
    ${img(uiIcon("app-icon"), "setup-icon")}
    <h2 class="setup-brand-title">Guildmaster’s Companion</h2>
    ${subtitle ? `<p class="setup-welcome">${subtitle}</p>` : ""}
  </div>`;

const renderSetup = (): string => `
  <main class="setup">
    <section class="setup-card">
      ${renderSetupBrand("Welcome, archaeologist")}
      <p>Enter your RuneScape name to pull your Archaeology level and XP. Collections are filtered to what you can complete at that level.</p>
      <label class="setup-field">
        <span>RuneScape display name</span>
        <input id="setup-name" autocomplete="off" placeholder="Your character name" value="${esc(state.displayName)}">
      </label>
      <button id="setup-load" class="gold-button wide">Load my Archaeology level</button>
      <button id="setup-toggle" class="link-button">${manualSetup ? "▾" : "▸"} Enter my level manually instead</button>
      ${manualSetup ? `
        <div class="setup-manual">
          <div class="inline-fields">
            <label><span>Level</span><input id="setup-level" type="number" min="1" max="120" value="${state.level}"></label>
            <label><span>XP</span><input id="setup-xp" type="number" min="0" value="${state.xp}"></label>
          </div>
          <button id="setup-manual" class="secondary-button wide">Save and continue</button>
        </div>` : ""}
      <div class="setup-mode">
        <span>How will you track items?</span>
        <div class="mode-row">
          <div class="mode-option">
            <button type="button" class="mode-chip ${state.entryMode === "auto" ? "active" : ""}" data-entry-mode="auto">
              Auto
              <span class="mode-recommended">(Recommended)</span>
            </button>
            <p class="mode-desc">Scan your bank and storage to fill in what you own</p>
          </div>
          <div class="mode-option">
            <button type="button" class="mode-chip ${state.entryMode === "manual" ? "active" : ""}" data-entry-mode="manual">Manual</button>
            <p class="mode-desc">Enter amounts yourself with the + and − controls</p>
          </div>
        </div>
      </div>
      <p class="setup-note">All data is stored locally. Change tracking mode anytime in Settings.</p>
    </section>
  </main>`;

const renderWizardProgress = (active: ScanWizardInterface | "done"): string => `
  <ol class="wizard-progress" aria-label="Setup progress">
    ${WIZARD_STEPS.map((step) => {
      const done = active === "done" || state.scanWizardDone[step];
      const skipped = active !== "done" && !done && wizardSkipped.has(step);
      const current = active !== "done" && active === step;
      const cls = [
        done ? "done" : "",
        skipped ? "skipped" : "",
        !done && !skipped && current ? "current" : "",
      ].filter(Boolean).join(" ");
      return `<li class="${cls}">${WIZARD_LABELS[step]}</li>`;
    }).join("")}
  </ol>`;

const wizardInventorySummary = (): {
  artefacts: number;
  materials: number;
  materialValue: number;
} => {
  let artefacts = 0;
  for (const artefact of archaeologyData.artefacts) {
    const count = getCount(state, artefact.id);
    artefacts += count.damaged + count.restored;
  }
  let materials = 0;
  let materialValue = 0;
  for (const material of archaeologyMaterials()) {
    const qty = getMaterial(state, material.id);
    if (!qty) continue;
    materials += qty;
    const price = materialPrice(material.id);
    if (price !== null) materialValue += price * qty;
  }
  return { artefacts, materials, materialValue };
};

const renderScanWizardDone = (): string => {
  const scannedAll = WIZARD_STEPS.every((step) => state.scanWizardDone[step]);
  const summary = wizardInventorySummary();
  const title = scannedAll ? "All storage scanned" : "You’re ready to dig";
  const blurb = scannedAll
    ? "Bank, material storage, and workbench are on your list. Run scan again anytime from Settings if something changes."
    : "Skipped steps can be scanned later from Settings. Everything you’ve added is saved locally.";

  const priceAtRender = getPriceVersion();
  void ensureMaterialPrices().then(() => {
    if (
      getPriceVersion() !== priceAtRender &&
      needsScanWizard() &&
      !nextWizardStep()
    ) {
      render();
    }
  });

  return `
    <main class="setup wizard">
      <section class="wizard-card wizard-scan wizard-done">
        ${renderSetupBrand()}
        ${renderWizardProgress("done")}
        <div class="wizard-done-copy">
          <h3 class="wizard-done-title">${title}</h3>
          <p>${blurb}</p>
        </div>
        <div class="wizard-done-stats">
          <article><span>Artefacts</span><strong>${formatNumber(summary.artefacts)}</strong></article>
          <article><span>Materials</span><strong>${formatNumber(summary.materials)}</strong></article>
          <article><span>Material value</span><strong>${formatGp(summary.materialValue)}</strong></article>
        </div>
        <button id="wizard-finish" class="gold-button wide">Complete setup</button>
      </section>
    </main>`;
};

const renderScanWizard = (): string => {
  const step = nextWizardStep();
  if (!step) return renderScanWizardDone();

  const status = getAlt1Status();
  const canScan = status.pixelPermission && status.linked;
  const capturing = scanBusy && scanLive && !scanStopRequested;
  const finishing = scanBusy && (!scanLive || scanStopRequested);
  const scanDisabled = !canScan || finishing;
  const scanLabel = capturing || finishing ? "Finish" : "Start scanning";
  const hasResults = Boolean(lastScan) && !scanBusy;
  const n = wizardStepNumber(step);
  const liveNote = scanBusy
    ? esc(scanMessage)
    : !canScan
      ? esc(status.message)
      : "";

  return `
    <main class="setup wizard">
      <section class="wizard-card wizard-scan${hasResults ? " wizard-has-results" : ""}">
        ${renderSetupBrand(hasResults ? undefined : "I see you’ve been busy — let’s check your inventory.")}
        <span class="eyebrow wizard-step-label">Step ${n} of ${WIZARD_STEPS.length}</span>
        ${renderWizardProgress(step)}
        ${hasResults ? "" : `<p class="wizard-instruction">${WIZARD_INSTRUCTIONS[step]}</p>`}
        ${liveNote ? `<p class="wizard-live">${liveNote}</p>` : ""}
        ${hasResults ? "" : `<button class="${capturing ? "secondary-button" : "gold-button"} wide" id="start-scan" ${scanDisabled ? "disabled" : ""}>${scanLabel}</button>`}
        ${renderScanResults({ hideActions: hasResults && Boolean(lastScan?.hits.length) })}
        <div class="wizard-footer${hasResults && lastScan?.hits.length ? " wizard-footer-actions" : ""}">
          ${hasResults && lastScan?.hits.length
            ? `
          <button id="add-scan" class="gold-button" title="Add these amounts to your tracked inventory">Add to inventory</button>
          <button id="discard-scan" class="secondary-button">Discard</button>`
            : `
          <button id="wizard-skip-step" class="secondary-button wizard-skip-step" ${scanBusy ? "disabled" : ""}>Skip this step</button>
          <button id="wizard-skip-all" class="link-button" ${scanBusy ? "disabled" : ""}>Skip all</button>`}
        </div>
      </section>
    </main>`;
};

/* ------------------------------------------------------------- dashboard */

const isFavorite = (collectionId: string): boolean =>
  state.favoriteCollections.includes(collectionId);

const toggleFavorite = (collectionId: string): void => {
  if (isFavorite(collectionId)) {
    state.favoriteCollections = state.favoriteCollections.filter((id) => id !== collectionId);
  } else {
    state.favoriteCollections = [...state.favoriteCollections, collectionId];
  }
  saveStateNow(state);
};

const favoriteStarButton = (collectionId: string, compact = false): string => {
  const on = isFavorite(collectionId);
  return `<button type="button" class="favorite-star ${on ? "on" : ""} ${compact ? "compact" : ""}" data-favorite="${esc(collectionId)}" title="${on ? "Remove from favourites" : "Add to favourites"}" aria-label="${on ? "Remove from favourites" : "Add to favourites"}" aria-pressed="${on ? "true" : "false"}">${on ? "★" : "☆"}</button>`;
};

const renderRecommendation = (
  progress: ReturnType<typeof getCollectionProgress>,
  options?: { label?: string; reason?: "chronotes" | "tetracompass" | "other" },
): string => renderCollectionCard(progress.collection, options);

const materialByName = new Map(
  archaeologyData.materials.map((material) => [
    material.name.toLowerCase(),
    material,
  ]),
);

const applyRestoredArtefacts = (
  artefact: import("./types").Artefact,
  quantity: number,
): {
  applied: number;
  materials: { name: string; quantity: number }[];
} => {
  let applied = 0;
  const materialsUsed = new Map<string, number>();
  for (let i = 0; i < quantity; i += 1) {
    const count = getCount(state, artefact.id);
    if (count.damaged < 1) break;
    setCount(state, artefact.id, "damaged", count.damaged - 1);
    setCount(state, artefact.id, "restored", count.restored + 1);
    for (const entry of artefact.materials) {
      if (entry.name.includes("(damaged)")) continue;
      const material = materialByName.get(entry.name.toLowerCase());
      if (!material) continue;
      const owned = getMaterial(state, material.id);
      const take = Math.min(owned, entry.quantity);
      setMaterial(state, material.id, Math.max(0, owned - entry.quantity));
      if (take > 0) {
        materialsUsed.set(
          material.name,
          (materialsUsed.get(material.name) ?? 0) + take,
        );
      }
    }
    applied += 1;
  }
  return {
    applied,
    materials: [...materialsUsed.entries()].map(([name, qty]) => ({
      name,
      quantity: qty,
    })),
  };
};

const renderExcavationRate = (): string => {
  const snap = excavationSnapshot();
  if (!snap.excavating || snap.gpPerHour === null) {
    return `
      <article class="stat-card excavation-rate" id="excavation-rate">
        <span>Excavation value</span>
        <strong class="muted-stat">—</strong>
        <small>Not currently excavating</small>
      </article>`;
  }

  const minutes = Math.max(1, Math.round(snap.elapsedMs / 60_000));
  return `
    <article class="stat-card excavation-rate active" id="excavation-rate">
      <span>Excavation value</span>
      <strong>${formatGp(snap.gpPerHour)} gp/h</strong>
      <small>${formatGp(snap.sessionGp)} gp · ${snap.findCount} finds · ${minutes}m</small>
    </article>`;
};

const refreshExcavationRateCard = (): void => {
  const card = document.querySelector("#excavation-rate");
  if (!card) return;
  card.outerHTML = renderExcavationRate().trim();
};

const companionModeLabel = (
  mode: "idle" | "excavate" | "restore" | "off" | "starting",
): { title: string; detail: string; className: string } => {
  if (mode === "starting") {
    return {
      title: "Starting…",
      detail: "Connecting companion watcher",
      className: "mode-idle",
    };
  }
  if (mode === "off") {
    const alt1 = getAlt1Status();
    let detail = "Open this app inside Alt1";
    if (alt1.available && !alt1.pixelPermission) {
      detail = "Enable “View screen” in Alt1 app permissions";
    } else if (alt1.available && !alt1.linked) {
      detail = "Link the RuneScape client in Alt1";
    } else if (alt1.available) {
      detail = "Watcher not running — try Force idle / reload";
    }
    return {
      title: "Watcher off",
      detail,
      className: "",
    };
  }
  if (mode === "excavate") {
    return {
      title: "Excavating",
      detail: "Chat finds + artefact popups",
      className: "mode-excavate",
    };
  }
  if (mode === "restore") {
    const status = companionWatcher?.getRestoreStatus();
    const detail = status?.artefactName
      ? status.progress
        ? `Restoring · ${status.artefactName} ${status.progress}`
        : `Restoring · ${status.artefactName}`
      : status?.message || "Workbench restore";
    return {
      title: "Restoring",
      detail,
      className: "mode-restore",
    };
  }
  return {
    title: "Idle",
    detail: "Alternating dig ↔ restore probes",
    className: "mode-idle",
  };
};

const companionModeFingerprint = (): string => {
  if (companionWatcherStarting) return "starting";
  if (!companionWatcher?.running) {
    const alt1 = getAlt1Status();
    return `off:${alt1.available}:${alt1.pixelPermission}:${alt1.linked}`;
  }
  const mode = companionWatcher.modeName;
  if (mode === "restore") {
    const status = companionWatcher.getRestoreStatus();
    return `restore:${status.artefactName ?? ""}:${status.progress ?? ""}:${status.message}`;
  }
  return mode;
};

let lastCompanionModeFingerprint = "";

const renderCompanionMode = (): string => {
  const running = Boolean(companionWatcher?.running);
  const mode = companionWatcherStarting
    ? "starting"
    : running
      ? companionWatcher!.modeName
      : "off";
  const { title, detail, className } = companionModeLabel(mode);
  const fp = companionModeFingerprint();
  lastCompanionModeFingerprint = fp;
  return `
    <article class="stat-card companion-mode ${className}" id="companion-mode" data-mode-fp="${esc(fp)}">
      <span>Watcher mode</span>
      <strong>${esc(title)}</strong>
      <small title="${esc(detail)}">${esc(detail)}</small>
      ${running ? `<button type="button" class="text-button mode-reset" id="force-idle-mode" title="Unstick if mode is wrong">Force idle</button>` : ""}
    </article>`;
};

const refreshCompanionModeCard = (): void => {
  const card = document.querySelector("#companion-mode");
  if (!card) return;
  const next = companionModeFingerprint();
  // Avoid rewriting the DOM when nothing changed — that was the flicker.
  if (next === lastCompanionModeFingerprint && card.getAttribute("data-mode-fp") === next) {
    return;
  }
  lastCompanionModeFingerprint = next;
  card.outerHTML = renderCompanionMode().trim();
};

let companionModeTimer: number | undefined;

const syncCompanionModeTimer = (): void => {
  const want = isDevToolsActive() && Boolean(companionWatcher?.running);
  if (want && companionModeTimer === undefined) {
    companionModeTimer = window.setInterval(() => {
      refreshCompanionModeCard();
    }, 500);
  } else if (!want && companionModeTimer !== undefined) {
    window.clearInterval(companionModeTimer);
    companionModeTimer = undefined;
  }
  if (want) refreshCompanionModeCard();
};

const syncExcavationRateTimer = (): void => {
  const excavating = excavationSnapshot().excavating;
  if (excavating && excavationRateTimer === undefined) {
    excavationRateTimer = window.setInterval(() => {
      refreshExcavationRateCard();
      syncExcavationRateTimer();
    }, 1_000);
  } else if (!excavating && excavationRateTimer !== undefined) {
    window.clearInterval(excavationRateTimer);
    excavationRateTimer = undefined;
    refreshExcavationRateCard();
  }
};

const recordWatcherFindValue = async (
  event: import("./watcher").WatcherEvent,
): Promise<void> => {
  if (event.type === "tetracompass") return;
  if (event.type === "material") {
    const price =
      priceForName(event.material.name) ??
      (await ensurePriceForName(event.material.name));
    if (price) noteExcavationValue(price * event.quantity, event.quantity);
    return;
  }

  // Damaged artefacts from digs — use GE price when the item is tradeable.
  const name = event.artefact.damagedName || `${event.artefact.name} (damaged)`;
  const price = priceForName(name) ?? (await ensurePriceForName(name));
  if (price) noteExcavationValue(price * event.quantity, event.quantity);
};

const renderTetraTracker = (): string => {
  const open = !collapsed.has("overview:tetra");
  const ready = tetraCompassesReady(state);
  const missing = TETRA_PIECE_IDS.filter((id) => getTetraPiece(state, id) < 1).length;
  const pieces = TETRA_PIECE_IDS.map((id) => {
    const count = getTetraPiece(state, id);
    return `<div class="piece ${count ? "have" : "missing"}" title="${esc(tetraPieceLabel(id))}: ${formatNumber(count)}">
      ${img(tetraPieceIcon(id), "piece-icon")}<span>${count || "–"}</span>
    </div>`;
  }).join("");

  const status = ready
    ? `<div class="tetra-ready"><strong>${ready}×</strong><span>ready to assemble</span></div>`
    : missing
      ? `<div class="tetra-ready"><span>${missing} missing</span></div>`
      : "";

  return `
    <section class="panel tetra-tracker ${open ? "open" : ""}">
      <div class="panel-heading">
        <button type="button" class="panel-collapse" data-collapse="overview:tetra" aria-expanded="${open ? "true" : "false"}">
          <span class="chevron">▶</span>
          <h2>Tetracompass</h2>
          ${open ? `<span class="eyebrow">Owned pieces</span>` : ""}
        </button>
        ${open ? status : ""}
      </div>
      ${open ? `<div class="pieces">${pieces}</div>` : ""}
    </section>`;
};

const renderDashboard = (): string => {
  const ready = progressList().filter((progress) => progress.restoredSets > 0);
  const favOpen = !collapsed.has("overview:favourites");
  const recOpen = !collapsed.has("overview:recommended");
  const opportunities = recOpen ? bestCollectionOpportunities(state) : [];
  const favorites = favOpen
    ? state.favoriteCollections
        .map((id) => archaeologyData.collections.find((collection) => collection.id === id))
        .filter((collection): collection is Collection => Boolean(collection))
        .map((collection) => getCollectionProgress(collection, state))
    : [];

  return `
    <main>
      <section class="stats-grid">
        ${renderExcavationRate()}
        <article class="stat-card"><span>Inventory value</span><strong>${formatGp(inventoryMaterialsValue())}</strong><small>GE · materials</small></article>
        <article class="stat-card"><span>Restoration XP</span><strong>${formatNumber(pendingXp())}</strong><small>Available from damaged</small></article>
        <article class="stat-card"><span>Ready collections</span><strong>${ready.length}</strong><small>At least one restored set</small></article>
      </section>
      ${renderTetraTracker()}
      <section class="panel ${favOpen ? "open" : ""}">
        <div class="panel-heading">
          <button type="button" class="panel-collapse" data-collapse="overview:favourites" aria-expanded="${favOpen ? "true" : "false"}">
            <span class="chevron">▶</span>
            <h2>Favourites</h2>
          </button>
          ${favOpen ? `<button class="text-button" data-view="collections">Browse</button>` : ""}
        </div>
        ${favOpen
          ? `<div class="collection-grid">
          ${favorites.length
            ? favorites.map((progress) => renderRecommendation(progress)).join("")
            : `<div class="empty">No favourites yet. Open Collections and tap the star on a collection to pin it here.</div>`}
        </div>`
          : ""}
      </section>
      <section class="panel ${recOpen ? "open" : ""}">
        <div class="panel-heading">
          <button type="button" class="panel-collapse" data-collapse="overview:recommended" aria-expanded="${recOpen ? "true" : "false"}">
            <span class="chevron">▶</span>
            <h2>Recommended collections</h2>
            ${recOpen ? `<span class="eyebrow">For level ${state.level}</span>` : ""}
          </button>
          ${recOpen ? `<button class="text-button" data-view="collections">View all</button>` : ""}
        </div>
        ${recOpen
          ? `<p class="scan-hint">Best picks for chronotes, tetracompass pieces${state.level >= 77 ? ", and dung tokens" : ""}.</p>
        <div class="collection-grid">
          ${opportunities.length
            ? opportunities.map((entry) => renderRecommendation(entry.progress, { label: entry.label, reason: entry.reason })).join("")
            : `<div class="empty">No collections available at this level yet.</div>`}
        </div>`
          : ""}
      </section>
    </main>`;
};

/* ------------------------------------------------------------- artefacts */

const isManual = (): boolean => state.entryMode === "manual";

const quantityControl = (
  id: string, kind: "damaged" | "restored", value: number,
): string => {
  if (!isManual()) {
    return `<span class="qty-readout ${value ? "" : "zero"}" title="${kind}">${value}</span>`;
  }
  return `
  <div class="quantity" title="${kind}">
    <button aria-label="Remove one ${kind}" data-adjust="${id}" data-kind="${kind}" data-delta="-1">−</button>
    <input aria-label="${kind}" inputmode="numeric" min="0" type="number" value="${value}" data-count="${id}" data-kind="${kind}">
    <button aria-label="Add one ${kind}" data-adjust="${id}" data-kind="${kind}" data-delta="1">+</button>
  </div>`;
};

const materialQuantity = (id: string, value: number, name: string): string => {
  if (!isManual()) {
    return `<span class="qty-readout ${value ? "" : "zero"}">${value}</span>`;
  }
  return `
    <div class="quantity">
      <button aria-label="Remove one" data-material-adjust="${id}" data-delta="-1">−</button>
      <input aria-label="${esc(name)}" inputmode="numeric" min="0" type="number" value="${value}" data-material-count="${id}">
      <button aria-label="Add one" data-material-adjust="${id}" data-delta="1">+</button>
    </div>`;
};

const digSiteTip = (artefact: Artefact): string => {
  const sites = artefact.sources.length
    ? artefact.sources.join(" · ")
    : "No dig site listed";
  const count = getCount(state, artefact.id);
  const each = artefactRestoreCost(artefact);
  const location = `Dig sites: ${sites}`;
  if (each === null) return `Lv ${artefact.level}\n\n${location}`;
  let restore = `Cost to restore: ${formatGp(each)} gp each`;
  if (count.damaged > 1) {
    restore += ` · ${formatGp(each * count.damaged)} gp for ${count.damaged} damaged`;
  } else if (count.damaged === 1) {
    restore += ` · ${formatGp(each)} gp for 1 damaged`;
  }
  return `${restore}\n\nLv ${artefact.level} · ${location}`;
};

const materialTip = (material: MaterialInfo): string => {
  const price = materialPrice(material.id);
  const priceBit = price !== null ? `${formatGp(price)} gp` : "—";
  const sites = materialFindSites(material);
  const located = sites.length ? sites.join(" · ") : "unknown";
  return `${priceBit}\n\nLocated at: ${located}`;
};

const tetraPieceQuantityControl = (id: TetraPieceId, value: number): string => {
  if (!isManual()) {
    return `<span class="qty-readout ${value ? "" : "zero"}">${value}</span>`;
  }
  return `
    <div class="quantity">
      <button aria-label="Remove one ${id}" data-tetra-adjust="${id}" data-delta="-1">−</button>
      <input aria-label="${esc(tetraPieceLabel(id))}" inputmode="numeric" min="0" type="number" value="${value}" data-tetra-count="${id}">
      <button aria-label="Add one ${id}" data-tetra-adjust="${id}" data-delta="1">+</button>
    </div>`;
};

const renderTetraPieceTile = (id: TetraPieceId): string => {
  const count = getTetraPiece(state, id);
  return `
    <article class="slot-tile ${count ? "owned" : ""} ${isManual() ? "manual" : "auto"}" data-tetra-row="${id}">
      ${img(tetraPieceIcon(id), "slot-icon")}
      <div class="slot-body">
        <strong>${esc(tetraPieceLabel(id))}</strong>
        <div class="slot-counts single">${tetraPieceQuantityControl(id, count)}</div>
      </div>
      <div class="slot-tip" role="tooltip">${esc(`Dig tracker · excavate chat / bank scan\n\n${id}`)}</div>
    </article>`;
};

const tetraGroupMatchesSearch = (query: string): boolean => {
  if (!query) return true;
  return (
    "tetracompass".includes(query) ||
    "tetra".includes(query) ||
    TETRA_PIECE_IDS.some(
      (id) => id.includes(query) || tetraPieceLabel(id).toLowerCase().includes(query),
    )
  );
};

const renderTetraArtefactGroup = (): string => {
  const key = "culture:Tetracompass";
  const isOpen = !collapsed.has(key);
  const owned = TETRA_PIECE_IDS.reduce((sum, id) => sum + getTetraPiece(state, id), 0);
  const ready = tetraCompassesReady(state);
  return `
    <section class="group ${isOpen ? "open" : ""}">
      <button class="group-header" data-collapse="${key}">
        <span class="chevron">▶</span>
        <strong>Tetracompass</strong>
        <span class="group-count">${TETRA_PIECE_IDS.length}</span>
        <span class="group-owned">${owned} owned${ready ? ` · ${ready} ready` : ""}</span>
      </button>
      ${isOpen ? `<div class="slot-grid">${TETRA_PIECE_IDS.map(renderTetraPieceTile).join("")}</div>` : ""}
    </section>`;
};

const renderArtefactTile = (artefact: Artefact): string => {
  const count = getCount(state, artefact.id);
  const owned = count.damaged + count.restored > 0;
  return `
    <article class="slot-tile ${owned ? "owned" : ""} ${isManual() ? "manual" : "auto"}" data-row="${artefact.id}">
      ${img(artefactIcon(artefact.id), "slot-icon")}
      <div class="slot-body">
        <strong>${esc(artefact.name)}</strong>
        <div class="slot-counts">
          <span class="slot-tag">D</span>${quantityControl(artefact.id, "damaged", count.damaged)}
          <span class="slot-tag">R</span>${quantityControl(artefact.id, "restored", count.restored)}
        </div>
      </div>
      <div class="slot-tip" role="tooltip">${esc(digSiteTip(artefact))}</div>
    </article>`;
};

const renderArtefactGroups = (): string => {
  const query = search.toLowerCase().trim();
  const matches = archaeologyData.artefacts.filter((artefact) =>
    !query ||
    artefact.name.toLowerCase().includes(query) ||
    artefact.alignment.toLowerCase().includes(query) ||
    artefact.sources.some((source) => source.toLowerCase().includes(query)),
  );

  const groups = CULTURES
    .map((culture) => ({
      culture,
      artefacts: matches
        .filter((artefact) => artefact.alignment === culture)
        .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.artefacts.length);

  const showTetra = tetraGroupMatchesSearch(query);
  if (!groups.length && !showTetra) {
    return `<div class="empty">No artefacts match that search.</div>`;
  }

  const cultureHtml = groups.map((group) => {
    const key = `culture:${group.culture}`;
    const isOpen = !collapsed.has(key);
    const owned = group.artefacts.reduce((total, artefact) => {
      const count = getCount(state, artefact.id);
      return total + count.damaged + count.restored;
    }, 0);

    return `
      <section class="group ${isOpen ? "open" : ""}">
        <button class="group-header" data-collapse="${key}">
          <span class="chevron">▶</span>
          <strong>${esc(group.culture)}</strong>
          <span class="group-count">${group.artefacts.length}</span>
          <span class="group-owned">${owned} owned</span>
        </button>
        ${isOpen ? `<div class="slot-grid">${group.artefacts.map(renderArtefactTile).join("")}</div>` : ""}
      </section>`;
  }).join("");

  return `${showTetra ? renderTetraArtefactGroup() : ""}${cultureHtml}`;
};

const renderArtefactPanel = (): string => `
  <div class="toolbar">
    <label class="search"><span>⌕</span><input id="artefact-search" type="search" placeholder="Search artefacts or cultures…" value="${esc(search)}"></label>
    <button class="secondary-button" id="toggle-all-groups">Collapse all</button>
  </div>
  <p class="list-hint">Hover over an icon for more details.</p>
  <section id="artefact-groups" class="groups">${renderArtefactGroups()}</section>`;

/* ------------------------------------------------------------- materials */

const renderMaterialTile = (material: MaterialInfo): string => {
  const stored = getMaterial(state, material.id);
  return `
    <article class="slot-tile material-slot ${stored ? "owned" : ""} ${isManual() ? "manual" : "auto"}" data-material-row="${material.id}">
      ${img(materialIcon(material.id), "slot-icon")}
      <div class="slot-body">
        <strong>${esc(material.name)}</strong>
        <div class="slot-counts single">${materialQuantity(material.id, stored, material.name)}</div>
      </div>
      <div class="slot-tip" role="tooltip">${esc(materialTip(material))}</div>
    </article>`;
};

const renderMaterialRows = (): string => {
  const query = materialSearch.toLowerCase().trim();
  const matches = archaeologyMaterials().filter(
    (material) => !query || material.name.toLowerCase().includes(query),
  );
  if (!matches.length) return `<div class="empty">No materials match that search.</div>`;

  const groups = MATERIAL_CATEGORIES
    .map((category) => ({
      category,
      materials: matches
        .filter((material) => materialCategory(material) === category)
        .sort((a, b) => b.usedInArtefacts - a.usedInArtefacts || a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.materials.length);

  return groups.map((group) => {
    const key = `material:${group.category}`;
    const isOpen = !collapsed.has(key);
    const stored = group.materials.reduce(
      (total, material) => total + getMaterial(state, material.id), 0,
    );

    return `
      <section class="group ${isOpen ? "open" : ""}">
        <button class="group-header" data-collapse="${key}">
          <span class="chevron">▶</span>
          <strong>${esc(group.category)}</strong>
          <span class="group-count">${group.materials.length}</span>
          <span class="group-owned">${formatNumber(stored)} stored</span>
        </button>
        ${isOpen ? `<div class="slot-grid">${group.materials.map(renderMaterialTile).join("")}</div>` : ""}
      </section>`;
  }).join("");
};

const renderMaterialPanel = (): string => `
  <div class="toolbar">
    <label class="search"><span>⌕</span><input id="material-search" type="search" placeholder="Search materials…" value="${esc(materialSearch)}"></label>
    <button class="secondary-button" id="toggle-all-groups">Collapse all</button>
  </div>
  <p class="list-hint">Hover over an icon for more details.</p>
  <section id="material-list" class="groups">${renderMaterialRows()}</section>`;


const inventoryMaterialsValue = (): number => {
  let total = 0;
  for (const material of archaeologyMaterials()) {
    const qty = getMaterial(state, material.id);
    if (!qty) continue;
    const price = materialPrice(material.id);
    if (price !== null) total += price * qty;
  }
  return total;
};

const renderInventorySectionSummary = (): string => {
  if (inventorySection === "artefacts") {
    return `<span class="filter-row-summary">${formatNumber(ownedTotal())} owned</span>`;
  }
  const priceAtRender = getPriceVersion();
  void ensureMaterialPrices().then(() => {
    if (
      getPriceVersion() !== priceAtRender &&
      view === "inventory" &&
      inventorySection === "materials"
    ) {
      render();
    }
  });
  return `<span class="filter-row-summary">${formatGp(inventoryMaterialsValue())} gp</span>`;
};

const renderInventory = (): string => `
  <main>
    <div class="filter-row" role="tablist" aria-label="Inventory section">
      <button type="button" data-inventory-section="artefacts" class="${inventorySection === "artefacts" ? "active" : ""}">Artefacts</button>
      <button type="button" data-inventory-section="materials" class="${inventorySection === "materials" ? "active" : ""}">Materials</button>
      ${renderInventorySectionSummary()}
    </div>
    ${inventorySection === "artefacts" ? renderArtefactPanel() : renderMaterialPanel()}
  </main>`;

/* ----------------------------------------------------------- collections */

const hasDungTokenReward = (collection: Collection): boolean =>
  Boolean(collection.recurringReward?.name.toLowerCase().includes("dungeoneering"));

const renderCollectionCard = (
  collection: Collection,
  options?: { label?: string; reason?: "chronotes" | "tetracompass" | "other" },
): string => {
  const progress = getCollectionProgress(collection, state);
  const locked = collection.level > state.level;
  const perSet = collection.artefactChronotes + collection.bonusChronotes;
  const fav = isFavorite(collection.id);
  const unrestoredSets = progress.potentialSets - progress.restoredSets;
  const hasSets = progress.potentialSets > 0;
  const recurring =
    collection.recurringReward && collection.recurringReward.name !== "No"
      ? collection.recurringReward
      : null;
  const tetraCount = hasSets
    ? progress.totalTetracompassPieces
    : collection.tetracompassPieces;
  const reason = options?.reason;
  const setBadge = hasSets
    ? `<div class="set-count">
        <strong>${progress.potentialSets}×</strong>
        <span class="${progress.restoredSets ? "on" : ""}">${progress.restoredSets} restored</span>
        <span class="${unrestoredSets ? "on" : ""}">${unrestoredSets} broken</span>
      </div>`
    : "";
  const footerRight =
    hasSets && progress.restoredSets && !unrestoredSets
      ? `<span class="success">Ready to hand in</span>`
      : !hasSets
        ? `<span>${progress.missing.length} missing</span>`
        : "";
  // Mats to restore every remaining unrestored set (hide when nothing left to restore).
  const restoreMats =
    unrestoredSets > 0 && progress.restoreMaterials.length
      ? `<div class="restore-mats">
        <span class="restore-mats-label">Materials to finish</span>
        <div class="restore-mats-list">
          ${progress.restoreMaterials
            .map((entry) => {
              const material = archaeologyData.materials.find(
                (item) => item.name === entry.name,
              );
              const owned = material ? getMaterial(state, material.id) : 0;
              const have = owned >= entry.quantity;
              return `<span class="restore-mat ${have ? "have" : ""}" title="${esc(entry.name)}: ${formatNumber(owned)} owned · ${formatNumber(entry.quantity)} needed">
              ${material ? img(materialIcon(material.id), "tiny-icon") : ""}
              <strong>${formatNumber(entry.quantity)}</strong>
              <em>${esc(entry.name)}</em>
            </span>`;
            })
            .join("")}
        </div>
      </div>`
      : "";
  const chronotesClass = reason === "chronotes" ? "highlight" : "";
  const tetraClass = reason === "tetracompass" ? "highlight" : "";
  const otherClass = reason === "other" ? "highlight" : "";
  const eyebrow = options?.label
    ? `<span class="eyebrow"><em class="rec-label">${esc(options.label)}</em> · ${esc(collection.collector)} · Level ${collection.level}</span>`
    : `<span class="eyebrow">${esc(collection.collector)} · Level ${collection.level}</span>`;
  return `
    <article class="collection-card ${progress.completeSets ? "ready" : ""} ${locked ? "locked" : ""} ${fav ? "favorited" : ""}">
      <div class="collection-top">
        <div class="collection-heading">
          ${eyebrow}
          <div class="collection-title-line">
            <h3>${esc(collection.name)}</h3>
            ${favoriteStarButton(collection.id, true)}
          </div>
        </div>
        ${setBadge ? `<div class="collection-top-actions">${setBadge}</div>` : ""}
      </div>
      <div class="collection-rewards">
        <span class="${chronotesClass}">${img(uiIcon("chronotes"), "tiny-icon")}<strong>${formatNumber(hasSets ? progress.totalChronotes : perSet)}</strong>${hasSets ? "reward" : "per set"}</span>
        ${collection.tetracompassPieces ? `<span class="${tetraClass}">${img(uiIcon("tetracompass"), "tiny-icon")}<strong>${tetraCount}</strong>tetracompass piece${tetraCount === 1 ? "" : "s"}</span>` : ""}
        ${recurring && !collection.tetracompassPieces ? `<span class="${otherClass}"><strong>${recurring.quantity}</strong>${esc(recurring.name)}</span>` : ""}
      </div>
      <div class="pieces">${collection.artefacts
        .map((name) => {
          const artefact = archaeologyData.artefacts.find((item) => item.name === name);
          if (!artefact) return "";
          const count = getCount(state, artefact.id);
          const total = count.damaged + count.restored;
          return `<div class="piece ${total ? "have" : "missing"}" title="${esc(name)}: ${count.damaged} damaged, ${count.restored} restored">
          ${img(artefactIcon(artefact.id), "piece-icon")}<span>${total || "–"}</span>
        </div>`;
        })
        .join("")}</div>
      ${restoreMats}
      ${footerRight ? `<div class="card-footer">${footerRight}</div>` : ""}
    </article>`;
};

const COLLECTION_FILTERS: { id: string; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every collection" },
  { id: "favourites", label: "Favourites", hint: "Collections you starred" },
  { id: "chronotes", label: "Chronotes", hint: "Velucia museum turn-ins — best chronote farms" },
  { id: "tetra", label: "Tetracompass", hint: "Rewards a tetracompass piece" },
  { id: "dung", label: "Dung tokens", hint: "Large dungeoneering token boxes" },
];

const renderCollections = (): string => {
  const favoriteOrder = new Map(
    state.favoriteCollections.map((id, index) => [id, index]),
  );

  const filtered = archaeologyData.collections
    .map((collection) => getCollectionProgress(collection, state))
    .filter((progress) => {
      const { collection } = progress;
      switch (collectionFilter) {
        case "favourites":
          return isFavorite(collection.id);
        case "chronotes":
          return collection.collector === "Velucia"
            && collection.name !== "Museum - Training Weapons";
        case "tetra":
          return collection.tetracompassPieces > 0;
        case "dung":
          return hasDungTokenReward(collection);
        case "all":
        default:
          return true;
      }
    })
    .sort((a, b) => {
      if (collectionFilter === "favourites") {
        return (favoriteOrder.get(a.collection.id) ?? 0) - (favoriteOrder.get(b.collection.id) ?? 0);
      }
      if (collectionFilter === "tetra") {
        return a.collection.artefacts.length - b.collection.artefacts.length
          || a.collection.level - b.collection.level;
      }
      if (collectionFilter === "dung" || collectionFilter === "chronotes") {
        return b.collection.level - a.collection.level;
      }
      return Number(b.completeSets > 0) - Number(a.completeSets > 0)
        || a.collection.level - b.collection.level
        || a.collection.name.localeCompare(b.collection.name);
    });

  const active = COLLECTION_FILTERS.find((entry) => entry.id === collectionFilter)
    ?? COLLECTION_FILTERS[0];
  const emptyMessage = {
    favourites: "No favourites yet. Tap the star on a collection to pin it here.",
    chronotes: "No museum chronote collections found.",
    tetra: "No tetracompass collections found.",
    dung: "No dung-token collections found.",
    all: "No collections found.",
  }[collectionFilter] ?? "Nothing matches this filter.";

  return `
    <main>
      <div class="filter-row" role="tablist" aria-label="Collection filters">
        ${COLLECTION_FILTERS.map((entry) =>
          `<button type="button" data-filter="${entry.id}" class="${collectionFilter === entry.id ? "active" : ""}" title="${esc(entry.hint)}">${entry.label}</button>`,
        ).join("")}
      </div>
      <p class="scan-hint">${esc(active.hint)} · ${filtered.length} shown</p>
      <section class="collection-grid">
        ${filtered.length
          ? filtered.map((progress) => renderCollectionCard(progress.collection)).join("")
          : `<div class="empty">${esc(emptyMessage)}</div>`}
      </section>
    </main>`;
};

/* ------------------------------------------------------------------ scan */

const artefactsByName = [...archaeologyData.artefacts].sort((a, b) =>
  a.name.localeCompare(b.name),
);
const materialsByName = [...archaeologyMaterials()].sort((a, b) =>
  a.name.localeCompare(b.name),
);

// Options for the "teach this icon" dropdown, pre-selecting the closest guess.
const teachOptions = (mode: ScanMode, selected: string | null): string => {
  const options: string[] = [];
  if (mode === "materials" || mode === "both") {
    for (const material of materialsByName) {
      const key = materialLearnedKey(material.id);
      options.push(
        `<option value="${key}" ${key === selected ? "selected" : ""}>${esc(material.name)}</option>`,
      );
    }
    if (mode === "materials") return options.join("");
  }
  for (const kind of ["damaged", "restored"] as const) {
    for (const artefact of artefactsByName) {
      const key = artefactLearnedKey(artefact.id, kind);
      options.push(
        `<option value="${key}" ${key === selected ? "selected" : ""}>${esc(artefact.name)} (${kind})</option>`,
      );
    }
  }
  return options.join("");
};

/** Active cell-teach UI (confirm / hover banner) — shown next to Scan Preview. */
const renderCellTeachChrome = (scan: ScanResult): string => {
  if (pendingTeachConfirm) {
    const pending = pendingTeachConfirm;
    if (!pending.trackable) {
      return `
    <div class="teach-confirm">
      <img class="teach-crop" src="${pending.dataUrl}" alt="">
      <div class="teach-confirm-copy">
        <p class="scan-hint">Read <strong>${esc(pending.label)}</strong> — this isn’t a trackable item.</p>
        <div class="button-row">
          <button id="ignore-cell-teach" class="gold-button" title="Not an artefact or material — stop listing this icon">Ignore slot</button>
          <button id="cancel-cell-teach-confirm" class="secondary-button">Try again</button>
        </div>
      </div>
    </div>`;
    }
    return `
    <div class="teach-confirm">
      <img class="teach-crop" src="${pending.dataUrl}" alt="">
      <div class="teach-confirm-copy">
        <p class="scan-hint">Learn this slot as <strong>${esc(pending.label)}</strong>?</p>
        <div class="button-row">
          <button id="confirm-cell-teach" class="gold-button">Yes, learn it</button>
          <button id="cancel-cell-teach-confirm" class="secondary-button">No, try again</button>
        </div>
      </div>
    </div>`;
  }

  if (!cellTeach) {
    if (COMPACT_SCAN_PREVIEW && isHoverTeachActive()) {
      return `
    <div class="teach-banner" id="teach-hud">
      <p class="teach-banner-live" id="teach-hud-live">${esc(hoverTeachHint || "Hover the missed item in your bank — watch for the name in the top-left.")}</p>
      <div class="teach-banner-pick">
        <button id="cancel-cell-teach" class="secondary-button">Cancel</button>
      </div>
    </div>`;
    }
    return "";
  }

  return `
    <div class="teach-banner" id="teach-hud">
      <p class="teach-banner-live" id="teach-hud-live">${esc(hoverTeachHint || "Hover that bank slot — watch for the name in the top-left of the game.")}</p>
      <div class="teach-banner-pick">
        <button id="cancel-cell-teach" class="secondary-button">Cancel</button>
      </div>
    </div>`;
};

/** Unresolved-list / free-hover teach controls (not the cell confirm banner). */
const renderTeachPanel = (scan: ScanResult): string => {
  // Cell teach chrome lives in Scan Preview — keep it there when the grid exists.
  if (pendingTeachConfirm || cellTeach) {
    if (!scan.debugSlots.length && !scan.debugRows) {
      return renderCellTeachChrome(scan);
    }
    return "";
  }

  if (scan.interfaceKind === "bank") return "";

  const hoverActive = isHoverTeachActive();
  if (!hoverActive && !scan.unresolved.length) return "";

  const hoverBlock = hoverActive
    ? `
    <div class="teach-hover">
      <button id="hover-teach" class="gold-button">Stop hover teach</button>
      <p class="scan-hint">${esc(hoverTeachHint || "Hover an unmatched icon in-game.")}</p>
    </div>`
    : "";

  if (!scan.unresolved.length) return hoverBlock;

  return `
    ${hoverBlock}
    ${scan.unresolved.map((slot, index) => {
      const miss = scan.nearMisses.find((entry) => entry.cell === slot.cell);
      return `
        <div class="teach-row">
          <img class="teach-crop" src="${slot.dataUrl}" alt="unmatched icon">
          <div class="teach-fields">
            <select class="teach-select" data-teach="${index}">
              <option value="">Pick the item…</option>
              ${teachOptions(scan.mode, slot.guessKey)}
            </select>
            ${miss && miss.recall >= 55 ? `<div class="miss-alts">closest: ${esc(miss.name)} — ${miss.precision}% of its pixels, ${miss.recall}% of the slot</div>` : ""}
          </div>
          <div class="teach-actions">
            <button class="secondary-button teach-save" data-teach-save="${index}">Learn</button>
            <button class="secondary-button teach-ignore" data-teach-ignore="${index}" title="Not an artefact or material — stop listing this icon">Not mine</button>
          </div>
        </div>`;
    }).join("")}`;
};

// Grid preview of what the scan claimed. Missed slots stay blank until clicked
// to teach; named icons can be clicked again if the matcher got them wrong.
const storagePlaceLabel = (kind: ScanResult["interfaceKind"]): string =>
  kind === "bank" ? "bank" : kind === "workbench" ? "workbench" : "material storage";

/**
 * Trial layout (easy undo): pack captured hit icons only — no empty gaps —
 * flowing to the window width, hide the long named list, add a “+” teach slot.
 * Set to `false` to restore the spatial bank grid + named list.
 * Also noted in docs/PUBLISH.md under experimental UI.
 */
const COMPACT_SCAN_PREVIEW = true;

let compactScrollObserver: ResizeObserver | null = null;

/** Grow square cells so each row fills the scroll area (accounts for scrollbar width). */
const syncCompactPreviewScrollbar = (): void => {
  const scroll = document.querySelector<HTMLElement>(
    ".captured-grid-debug.compact-preview .captured-grid-scroll",
  );
  const grid = scroll?.querySelector<HTMLElement>(".captured-grid.compact-flow");
  if (!scroll || !grid) {
    compactScrollObserver?.disconnect();
    compactScrollObserver = null;
    return;
  }

  const GAP = 3;
  const MIN = 42;

  const update = (): void => {
    const el = document.querySelector<HTMLElement>(
      ".captured-grid-debug.compact-preview .captured-grid-scroll",
    );
    const flow = el?.querySelector<HTMLElement>(".captured-grid.compact-flow");
    if (!el || !flow) return;

    // A couple passes: cell size can toggle the scrollbar, which changes width.
    for (let i = 0; i < 3; i += 1) {
      const width = flow.clientWidth;
      if (width <= 0) return;
      const cols = Math.max(1, Math.floor((width + GAP) / (MIN + GAP)));
      const cell = Math.max(MIN, (width - GAP * (cols - 1)) / cols);
      flow.style.setProperty("--compact-cell", `${cell}px`);
      void el.offsetHeight;
    }
  };

  compactScrollObserver?.disconnect();
  update();
  requestAnimationFrame(() => {
    update();
    compactScrollObserver = new ResizeObserver(() => update());
    const el = document.querySelector<HTMLElement>(
      ".captured-grid-debug.compact-preview .captured-grid-scroll",
    );
    if (el) compactScrollObserver.observe(el);
  });
};

const collectPreviewSlots = (
  scan: ScanResult,
): (typeof scan.debugSlots)[number][] => {
  const byCell = new Map<string, (typeof scan.debugSlots)[number]>();
  for (const slot of scan.debugSlots) {
    const key = `${slot.row},${slot.column}`;
    const existing = byCell.get(key);
    if (!existing) {
      byCell.set(key, slot);
      continue;
    }
    if (existing.kind === "miss" && slot.kind === "hit") {
      byCell.set(key, slot);
      continue;
    }
    if (
      existing.kind === "miss" &&
      slot.kind === "miss" &&
      slot.cropDataUrl &&
      !existing.cropDataUrl
    ) {
      byCell.set(key, slot);
    }
  }

  const packed: (typeof scan.debugSlots)[number][] = [];
  if (COMPACT_SCAN_PREVIEW) {
    // Hits only, reading order — no empties / dashed miss placeholders.
    for (let row = 0; row < scan.debugRows; row += 1) {
      for (let column = 0; column < scan.debugColumns; column += 1) {
        const slot = byCell.get(`${row},${column}`);
        if (slot?.kind === "hit") packed.push(slot);
      }
    }
    return packed;
  }

  // Spatial layout: every bank cell, including empties.
  for (let row = 0; row < scan.debugRows; row += 1) {
    for (let column = 0; column < scan.debugColumns; column += 1) {
      const slot = byCell.get(`${row},${column}`);
      if (slot) packed.push(slot);
      else packed.push({
        row,
        column,
        key: "",
        name: "",
        quantity: 0,
        iconPath: "",
        kind: "miss",
      });
    }
  }
  return packed;
};

const renderCapturedGrid = (scan: ScanResult): string => {
  if (!scan.debugSlots.length && !scan.debugRows) return "";

  const slots = collectPreviewSlots(scan);
  const cells: string[] = [];
  const confirmingCell = pendingTeachConfirm;

  for (const slot of slots) {
    const { row, column } = slot;
    const teachingThis =
      (cellTeach?.row === row && cellTeach?.column === column) ||
      (confirmingCell?.row === row && confirmingCell?.column === column);

    if (COMPACT_SCAN_PREVIEW) {
      if (slot.kind !== "hit") continue;
      const reteachTitle = teachingThis
        ? `Teaching this slot — hover it in-game (row ${row + 1}, column ${column + 1})`
        : `Click to correct if misidentified: ${esc(slot.name)} × ${slot.quantity}`;
      const teachState = confirmingCell && teachingThis
        ? " teach-captured"
        : teachingThis
          ? " teaching"
          : "";
      cells.push(`<div class="captured-grid-cell teachable reteachable${teachState}" data-teach-cell data-row="${row}" data-col="${column}" title="${reteachTitle}">
        ${img(`${import.meta.env.BASE_URL}${slot.iconPath}`, "captured-grid-icon")}
        ${slot.quantity > 1 ? `<b>${slot.quantity}</b>` : ""}
      </div>`);
      continue;
    }

    if (slot.kind === "miss" && slot.cropDataUrl) {
      if (teachingThis) {
        const captured = confirmingCell ? " teach-captured" : " teaching";
        cells.push(`<div class="captured-grid-cell${captured}" data-teach-cell data-row="${row}" data-col="${column}" title="Teaching this slot — hover it in-game (row ${row + 1}, column ${column + 1})">
          <img class="captured-grid-icon miss-crop" src="${slot.cropDataUrl}" alt="">
        </div>`);
      } else {
        cells.push(`<div class="captured-grid-cell empty teachable" data-teach-cell data-row="${row}" data-col="${column}" title="Click to add this missed icon (row ${row + 1}, column ${column + 1})"></div>`);
      }
      continue;
    }

    if (slot.kind === "miss" || !slot.key) {
      const title = slot.name
        ? `ignored (not archaeology) (row ${row + 1}, column ${column + 1})`
        : `empty slot (row ${row + 1}, column ${column + 1})`;
      cells.push(`<div class="captured-grid-cell empty" title="${title}"></div>`);
      continue;
    }

    const reteachTitle = teachingThis
      ? `Teaching this slot — hover it in-game (row ${row + 1}, column ${column + 1})`
      : `Click to correct if misidentified: ${esc(slot.name)} × ${slot.quantity} (row ${row + 1}, column ${column + 1})`;
    const teachState = confirmingCell && teachingThis
      ? " teach-captured"
      : teachingThis
        ? " teaching"
        : "";
    cells.push(`<div class="captured-grid-cell teachable reteachable${teachState}" data-teach-cell data-row="${row}" data-col="${column}" title="${reteachTitle}">
      ${img(`${import.meta.env.BASE_URL}${slot.iconPath}`, "captured-grid-icon")}
      ${slot.quantity > 1 ? `<b>${slot.quantity}</b>` : ""}
    </div>`);
  }

  if (COMPACT_SCAN_PREVIEW) {
    const adding = isHoverTeachActive() && !cellTeach;
    cells.push(`
      <button type="button" class="captured-grid-cell compact-add${adding ? " teaching" : ""}" id="compact-add-item" title="Add a missed item — hover it in your bank">
        <img class="captured-grid-icon" src="${import.meta.env.BASE_URL}ui/add-slot.png" alt="Add">
      </button>`);
  }

  const layoutNote = COMPACT_SCAN_PREVIEW
    ? "Wrong name? Click the icon, then hover that slot in-game. Missed something? Use + and hover the item in your bank."
    : "Missed an item? Click its blank dashed cell. Wrong name? Click the icon. Then hover that slot so the top-left options text shows its name.";

  const teachChrome = renderCellTeachChrome(scan);
  const columns = COMPACT_SCAN_PREVIEW
    ? undefined
    : Math.max(1, scan.debugColumns);

  return `
    <div class="captured-grid-debug${COMPACT_SCAN_PREVIEW ? " compact-preview" : ""}">
      ${teachChrome}
      <p class="scan-hint">${layoutNote}</p>
      <div class="captured-grid-scroll">
        <div class="captured-grid${COMPACT_SCAN_PREVIEW ? " compact-flow" : ""}"${columns ? ` style="--debug-columns:${columns}"` : ""}>${cells.join("")}</div>
      </div>
    </div>`;
};

const renderScanResults = (opts?: { hideActions?: boolean }): string => {
  if (scanBusy) return "";
  if (!lastScan) return "";
  const teach = renderTeachPanel(lastScan);
  if (!lastScan.hits.length) {
    const debug = renderCapturedGrid(lastScan);
    return `<section class="panel">${teach}<div class="empty">Nothing recognised on screen. Open your bank, workbench or material storage so the items are visible, then scan again.</div>${debug}</section>`;
  }

  const interfaceLabel = {
    bank: "Bank of Gielinor",
    workbench: "Workbench: damaged only",
    "material-storage": "Material Storage",
  }[lastScan.interfaceKind];
  const heading = COMPACT_SCAN_PREVIEW
    ? `<div class="panel-heading"><div><h2>${lastScan.hits.length} unique items found</h2></div></div>`
    : `<div class="panel-heading"><div><span class="eyebrow">${lastScan.hits.length} found · ${lastScan.durationMs} ms · ${interfaceLabel}${lastScan.stitchPreviewUrl ? ` · ${passLabel(scanPasses)}` : ""}</span><h2>${{ materials: "Materials", artefacts: "Artefacts", both: "Items" }[lastScan.mode]} found</h2></div></div>`;
  const namedList = COMPACT_SCAN_PREVIEW
    ? ""
    : `
      <div class="scan-results">
        ${lastScan.hits.map((hit) => hit.type === "artefact"
          ? `<div class="scan-hit">${img(artefactIcon(hit.artefact.id, hit.kind), "piece-icon")}<div><strong>${esc(hit.artefact.name)}</strong><span>${hit.kind}</span></div><b>${hit.quantity}</b></div>`
          : hit.type === "tetracompass"
            ? `<div class="scan-hit">${img(tetraPieceIcon(hit.piece), "piece-icon")}<div><strong>${esc(tetraPieceLabel(hit.piece))}</strong><span>tetracompass</span></div><b>${hit.quantity}</b></div>`
          : `<div class="scan-hit">${img(materialIcon(hit.material.id), "piece-icon")}<div><strong>${esc(hit.material.name)}</strong><span>material</span></div><b>${hit.quantity}</b></div>`,
        ).join("")}
      </div>`;

  const actions = opts?.hideActions
    ? ""
    : `
      <div class="button-row">
        <button id="add-scan" class="gold-button" title="Add these amounts to your tracked inventory">Add to inventory</button>
        <button id="discard-scan" class="secondary-button">Discard</button>
      </div>`;

  return `
    <section class="panel">
      ${teach}
      ${heading}
      ${namedList}
      ${renderCapturedGrid(lastScan)}
      ${actions}
      ${!lastScan.unresolved.length && lastScan.nearMisses.length ? `
        <details class="near-misses">
          <summary>Slots that were not matched (${lastScan.nearMisses.length})</summary>
          <p class="scan-hint">Closest unmatched icons — useful if something was skipped.</p>
          ${lastScan.nearMisses.map((miss) => `
            <div class="miss-row"><span>${esc(miss.name)}</span><b>${miss.precision}% pixels · ${miss.recall}% of slot</b></div>`).join("")}
        </details>` : ""}
    </section>`;
};

const renderScan = (): string => {
  // Scan controls live on Inventory; keep this tab for results/teach if opened.
  return `
    <main>
      ${renderScanResults() || `<section class="panel"><div class="empty">Use <strong>Run scan again</strong> in Settings to capture bank, workbench, or material storage.</div></section>`}
      <aside class="notice"><strong>Tip</strong><p>Matching uses in-game item sprites, so RuneScape should be at 100% interface scale. Results are always shown for review before anything is saved.</p></aside>
  </main>`;
};

/* -------------------------------------------------------------- settings */

const renderSettings = (): string => `
  <main class="settings-page">
    <section class="panel settings-form">
      <div class="panel-heading"><div><h2>Profile</h2></div></div>
      <label><span>RuneScape display name</span><input id="display-name" autocomplete="off" value="${esc(state.displayName)}" placeholder="Your character name"></label>
      <div class="inline-fields">
        <label><span>Level</span><input id="manual-level" type="number" min="1" max="120" value="${state.level}"></label>
        <label><span>Exact XP</span><input id="manual-xp" type="number" min="0" value="${state.xp}"></label>
      </div>
      <div class="button-row"><button id="hiscore-sync" class="gold-button">Load from hiscores</button><button id="save-profile" class="secondary-button">Save manually</button></div>
    </section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Appearance</h2></div></div>
      <div class="theme-row">
        ${[["classic", "Classic brown"], ["stone", "Stone grey"], ["dark", "Dig site green"], ["midnight", "Midnight"]]
          .map(([value, label]) =>
            `<button class="theme-chip ${state.theme === value ? "active" : ""}" data-theme="${value}"><span class="swatch swatch-${value}"></span>${label}</button>`,
          ).join("")}
      </div>
      <label class="toggle-row"><input id="compact-toggle" type="checkbox" ${state.compact ? "checked" : ""}><span>Compact layout</span></label>
      <div class="setup-mode settings-mode">
        <span>Entry mode</span>
        <div class="mode-row">
          <div class="mode-option">
            <button type="button" class="mode-chip ${state.entryMode === "auto" ? "active" : ""}" data-entry-mode="auto">
              Auto
              <span class="mode-recommended">(Recommended)</span>
            </button>
            <p class="mode-desc">Scan your bank and storage to fill in what you own</p>
          </div>
          <div class="mode-option">
            <button type="button" class="mode-chip ${state.entryMode === "manual" ? "active" : ""}" data-entry-mode="manual">Manual</button>
            <p class="mode-desc">Enter amounts yourself with the + and − controls</p>
          </div>
        </div>
      </div>
    </section>
    ${ENABLE_DEV_TOOLS ? `
    <section class="panel">
      <div class="panel-heading"><div><h2>Developer</h2><p>Local tools only — omitted from public releases.</p></div></div>
      <label class="toggle-row"><input id="dev-mode-toggle" type="checkbox" ${state.devMode ? "checked" : ""}><span>Enable developer tools</span></label>
      ${state.devMode ? `
      <p class="scan-hint">Watcher mode, Force idle, and Alt1 detection outlines (restore window / scan cells).</p>
      <div class="settings-dev-watcher">
        ${renderCompanionMode()}
      </div>` : ""}
    </section>` : ""}
    <section class="panel data-panel">
      <div class="panel-heading"><div><h2>Local data</h2><p>Back up or restore your tracked progress.</p></div></div>
      <div class="data-group">
        <span class="data-eyebrow">Backup</span>
        <div class="button-row">
          <button id="export-data" class="secondary-button">Export JSON</button>
          <label class="file-button">Import JSON<input id="import-data" type="file" accept="application/json"></label>
        </div>
      </div>
      <div class="data-group">
        <span class="data-eyebrow">Storage scan</span>
        <div class="button-row">
          <button id="rescan-storage" class="secondary-button">Run scan again</button>
        </div>
        <p class="scan-hint">Clears saved artefacts and materials, then walks you through the storage scan wizard again. Favourites are kept.</p>
      </div>
      ${learnedCount() || ignoredCount() ? `
      <div class="data-group">
        <span class="data-eyebrow">Scan icons</span>
        <div class="button-row">
          ${learnedCount() ? `<button id="forget-learned" class="secondary-button">Clear taught icons (${learnedCount()})</button>` : ""}
          ${ignoredCount() ? `<button id="forget-ignored" class="secondary-button">Clear ignored icons (${ignoredCount()})</button>` : ""}
        </div>
      </div>` : ""}
    </section>
    <section class="attribution">
      <p>Designed by RuneScape user <strong>Husafell</strong> — PM for requests and feedback.</p>
      <p>Data and item icons from <a href="${archaeologyData.source}" target="_blank" rel="noreferrer">The RuneScape Wiki</a>. RuneScape is © Jagex Ltd. This third-party app is not endorsed by Jagex.</p>
    </section>
  </main>`;

/* ---------------------------------------------------------------- render */

const render = (): void => {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.density = state.compact ? "compact" : "roomy";

  if (!state.setupComplete) {
    app.innerHTML = `<div class="app-body setup-only">${renderSetup()}</div>`;
    syncCompactPreviewScrollbar();
    return;
  }

  if (needsScanWizard()) {
    app.innerHTML = `<div class="app-body setup-only">${renderScanWizard()}</div>`;
    syncCompactPreviewScrollbar();
    return;
  }

  const content = {
    dashboard: renderDashboard, inventory: renderInventory,
    collections: renderCollections, scan: renderScan, settings: renderSettings,
  }[view]();

  app.innerHTML = `${renderHeader()}<div class="app-body">${content}</div>`;
  void ensureCompanionWatcherRunning();
  syncExcavationRateTimer();
  syncCompactPreviewScrollbar();
};

/* ----------------------------------------------------------- scan runner */

const modeForInterface = (
  kind: import("./scanner").ScanInterface,
): ScanMode => {
  if (kind === "material-storage") return "materials";
  if (kind === "bank") return "both";
  return "artefacts";
};

const setScanLiveStatus = (message: string): void => {
  scanMessage = message;
  const label = document.querySelector<HTMLElement>(".scan-live-status, .wizard-live");
  if (label) label.textContent = message;
};

const finishLiveScan = (): void => {
  if (!scanBusy || scanStopRequested) return;
  scanStopRequested = true;
  scanMessage = "Finishing…";
  render();
};

const runLiveStitchScan = async (): Promise<void> => {
  if (scanBusy) return;
  scanBusy = true;
  stopHoverTeach();
  hoverTeachHint = "";
  cellTeach = null;
  pendingTeachConfirm = null;
  scanLive = true;
  scanStopRequested = false;
  scanPasses = 0;
  lastScan = null;
  scanMessage = "Finding storage…";
  view = "inventory";
  render();

  try {
    const { locateStitchCrop, paneSignature, scanImageData, trimTrailingEmptySlotRows } =
      await import("./scanner");
    const {
      createStitch,
      appendSettledCrop,
      seedFromCapture,
      imageDataToPngUrl,
    } = await import("./storage-stitch");

    setScanLiveStatus("Finding storage grid…");
    render();
    const expect = needsScanWizard() ? nextWizardStep() ?? undefined : undefined;
    const { detected: located, crop } = await locateStitchCrop(expect);
    const mode = modeForInterface(located.kind);
    setScanLiveStatus(
      `Found ${
        { bank: "Bank", workbench: "Workbench", "material-storage": "Material Storage" }[located.kind]
      } — capturing…`,
    );
    render();
    // Crop is the left slot grid only (like your manual screenshots). While you
    // scroll we grab every settled view and overlap-align it onto one still.
    const stitch = createStitch(crop);
    let joinWarnings = 0;

    // Seed with the current view immediately.
    seedFromCapture(stitch);
    scanPasses = 1;
    setScanLiveStatus(`Capturing… ${passLabel(stitch.strips)}`);
    render();

    const settleBrief = async (): Promise<number | null> => {
      let previous: number | null = null;
      const deadline = performance.now() + 4000;
      while (!scanStopRequested && performance.now() < deadline) {
        const signature = paneSignature(stitch.area);
        if (signature !== null && signature === previous) return signature;
        previous = signature;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return previous;
    };

    let lastSig: number | null = stitch.lastSignature;
    while (!scanStopRequested) {
      setScanLiveStatus(`Capturing… ${passLabel(stitch.strips)}`);

      const settled = await settleBrief();
      if (scanStopRequested) break;
      if (settled === null) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (settled === lastSig) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }

      const status = appendSettledCrop(stitch);
      if (status.ok) {
        lastSig = stitch.lastSignature;
        scanPasses = stitch.strips;
        setScanLiveStatus(`Capturing… ${passLabel(stitch.strips)}, +${status.appendedPx}px`);
      } else if (status.reason === "no-overlap") {
        joinWarnings += 1;
        setScanLiveStatus(`Capturing… ${passLabel(stitch.strips)} — scroll back a bit (no overlap)`);
      } else {
        lastSig = settled;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Final strip at rest after Finish.
    appendSettledCrop(stitch);

    if (!stitch.composite || stitch.composite.height < 32) {
      showToast("Nothing captured — keep the storage open and try again.", "error");
      return;
    }

    // Bank stitches often keep empty floor under the last item; drop it so
    // matching walks a smaller still. Width stays full (resize / scroll safe).
    const composite =
      located.kind === "bank"
        ? trimTrailingEmptySlotRows(stitch.composite)
        : stitch.composite;

    const heightBeforeTrim = stitch.composite.height;
    const previewUrl = imageDataToPngUrl(composite);
    setScanLiveStatus("Matching…");
    render();

    const result = await scanImageData(
      composite,
      mode,
      (checked, total) => {
        const percent = Math.round((checked / total) * 100);
        setScanLiveStatus(`Matching… ${percent}%`);
      },
      {
        interfaceKind: located.kind,
        advancedMatching: true,
        debugOverlay: isDevToolsActive(),
        scrolling: false,
        fast: false,
      },
    );

    lastScan = {
      ...result,
      stitchPreviewUrl: previewUrl,
      stitchScreenOrigin: { x: crop.x, y: crop.y },
      stitchViewportHeight: crop.height,
      stitchHeightBeforeTrim: heightBeforeTrim,
    };
    scanPasses = stitch.strips;
    const warn =
      joinWarnings > 0
        ? ` (${passLabel(joinWarnings)} needed more overlap — check the preview)`
        : "";
    showToast(
      result.hits.length
        ? `Found ${result.hits.length} item type(s) from ${passLabel(stitch.strips)}.${warn}`
        : `Stitched ${passLabel(stitch.strips)} but nothing matched.${warn}`,
      result.hits.length ? "detect" : "error",
    );
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The scan failed.", "error");
  } finally {
    scanBusy = false;
    scanLive = false;
    render();
  }
};

const startScan = (): void => {
  void runLiveStitchScan();
};

const applyScan = (): void => {
  if (!lastScan) return;
  const scannedKind = lastScan.interfaceKind;
  for (const hit of lastScan.hits) {
    if (hit.type === "artefact") {
      const current = getCount(state, hit.artefact.id)[hit.kind];
      setCount(state, hit.artefact.id, hit.kind, current + hit.quantity);
    } else if (hit.type === "tetracompass") {
      // Bank is source of truth for owned pieces (same idea as materials).
      setTetraPiece(state, hit.piece, hit.quantity);
    } else {
      // Material storage / bank: only archaeology dig materials are tracked.
      if (!isArchaeologyMaterial(hit.material)) continue;
      setMaterial(state, hit.material.id, hit.quantity);
    }
  }
  state.lastScanAt = new Date().toISOString();
  const inWizard = needsScanWizard();
  const expected = inWizard ? nextWizardStep() : null;
  if (inWizard && expected && scannedKind === expected) {
    state.scanWizardDone[expected] = true;
  } else if (inWizard && WIZARD_STEPS.includes(scannedKind as ScanWizardInterface)) {
    state.scanWizardDone[scannedKind as ScanWizardInterface] = true;
  }
  saveStateNow(state);
  showToast(`Saved ${lastScan.hits.length} item type(s) to your list.`, "good");
  lastScan = null;

  if (inWizard) {
    render();
    return;
  }
  render();
};

const scanHitLabel = (hit: ScanHit): string =>
  hit.type === "artefact"
    ? hit.artefact.name
    : hit.type === "material"
      ? hit.material.name
      : tetraPieceLabel(hit.piece);

const learnedKeyForHit = (hit: ScanHit): string => {
  if (hit.type === "artefact") return artefactLearnedKey(hit.artefact.id, hit.kind);
  if (hit.type === "material") return materialLearnedKey(hit.material.id);
  return `tetra:${hit.piece}`;
};

const hitFromLearnedKey = (key: string, quantity: number): ScanHit | null => {
  const parsed = parseLearnedKey(key);
  if (!parsed) return null;
  // The user named this one, so it needs no corroborating.
  if (parsed.type === "artefact") {
    const artefact = archaeologyData.artefacts.find((item) => item.id === parsed.id);
    return artefact
      ? { type: "artefact", artefact, kind: parsed.kind, quantity, exact: true, edgeRow: false }
      : null;
  }
  const material = archaeologyData.materials.find((item) => item.id === parsed.id);
  return material
    ? { type: "material", material, quantity, exact: true, edgeRow: false }
    : null;
};

// Saves the crop under the chosen item and folds it into the review list so it
// is saved alongside the recognised hits and matches on its own next time.
const learnUnresolved = async (index: number): Promise<void> => {
  if (!lastScan) return;
  const slot = lastScan.unresolved[index];
  if (!slot) return;
  const select = document.querySelector<HTMLSelectElement>(`select[data-teach="${index}"]`);
  const key = select?.value;
  if (!key) {
    showToast("Pick the item this icon is first.", "error");
    return;
  }

  saveLearnedSprite(key, slot.dataUrl);
  const { clearTargetCache } = await import("./scanner");
  clearTargetCache();

  const hit = hitFromLearnedKey(key, slot.quantity);
  if (hit) {
    const existing = lastScan.hits.find((other) => learnedKeyForHit(other) === key);
    if (existing) existing.quantity += slot.quantity;
    else lastScan.hits.push(hit);
    lastScan.hits.sort((a, b) => scanHitLabel(a).localeCompare(scanHitLabel(b)));
  }

  // The slot is named now, so it is neither unresolved nor a near miss.
  const taughtCell = slot.cell;
  lastScan.unresolved.splice(index, 1);
  lastScan.nearMisses = lastScan.nearMisses.filter((miss) => miss.cell !== taughtCell);
  if (!lastScan.unresolved.length) lastScan.nearMisses = [];

  const label = hit
    ? scanHitLabel(hit) + (hit.type === "artefact" ? ` (${hit.kind})` : "")
    : "icon";
  showToast(`Learned ${label} — it will match on its own next scan.`, "good");
  render();
};

const iconPathForLearnedKey = (key: string): string => {
  const parsed = parseLearnedKey(key);
  if (!parsed) return "";
  // Debug grid uses public/sprites-framed/ paths (same as the matcher).
  if (parsed.type === "artefact") {
    const path = artefactIcon(parsed.id, parsed.kind);
    const file = path.split("/sprites/").pop();
    return file ? `sprites-framed/${file}` : "";
  }
  const path = materialIcon(parsed.id);
  const file = path.split("/sprites/").pop();
  return file ? `sprites-framed/${file}` : "";
};

const debugSlotLearnedKey = (slotKey: string): string | null => {
  if (slotKey.startsWith("miss:")) return null;
  if (slotKey.startsWith("mat:")) return slotKey;
  const split = slotKey.lastIndexOf(":");
  if (split < 0) return null;
  const id = slotKey.slice(0, split);
  const kind = slotKey.slice(split + 1);
  if (kind !== "damaged" && kind !== "restored") return null;
  return artefactLearnedKey(id, kind);
};

const learnFromHover = async (key: string, label: string, dataUrl?: string): Promise<void> => {
  if (dataUrl) saveLearnedSprite(key, dataUrl);
  const { clearTargetCache } = await import("./scanner");
  clearTargetCache();
  if (!lastScan) {
    showToast(`Learned ${label} — it will match on the next scan.`, "good");
    return;
  }
  const taughtCell = cellTeach ?? (
    pendingTeachConfirm
      ? { row: pendingTeachConfirm.row, column: pendingTeachConfirm.column }
      : null
  );
  const taughtSlot = taughtCell
    ? lastScan.debugSlots.find(
        (slot) =>
          slot.row === taughtCell.row && slot.column === taughtCell.column,
      )
    : undefined;
  const quantity = taughtSlot?.quantity ?? 1;
  const taughtCrop = taughtSlot?.cropDataUrl ?? dataUrl;

  // Correcting a misidentified hit: remove that cell's quantity from the old type.
  if (taughtSlot?.kind === "hit") {
    const oldKey = debugSlotLearnedKey(taughtSlot.key);
    if (oldKey && oldKey !== key) {
      const oldHit = lastScan.hits.find((other) => learnedKeyForHit(other) === oldKey);
      if (oldHit) {
        oldHit.quantity -= quantity;
        if (oldHit.quantity <= 0) {
          lastScan.hits = lastScan.hits.filter((other) => other !== oldHit);
        }
      }
    }
  }

  const hit = hitFromLearnedKey(key, quantity);
  if (hit) {
    const existing = lastScan.hits.find((other) => learnedKeyForHit(other) === key);
    if (!existing) {
      lastScan.hits.push(hit);
      lastScan.hits.sort((a, b) => scanHitLabel(a).localeCompare(scanHitLabel(b)));
    } else if (taughtCell && taughtSlot?.kind === "miss") {
      existing.quantity += quantity;
    } else if (taughtCell && taughtSlot?.kind === "hit") {
      const oldKey = debugSlotLearnedKey(taughtSlot.key);
      if (oldKey !== key) existing.quantity += quantity;
    }
  }

  if (taughtCell) {
    const iconPath = iconPathForLearnedKey(key);
    lastScan.debugSlots = lastScan.debugSlots.map((slot) => {
      if (slot.row !== taughtCell.row || slot.column !== taughtCell.column) {
        return slot;
      }
      return {
        ...slot,
        kind: "hit" as const,
        key: (() => {
          const parsed = parseLearnedKey(key);
          if (!parsed) return key;
          return parsed.type === "artefact"
            ? `${parsed.id}:${parsed.kind}`
            : `mat:${parsed.id}`;
        })(),
        name: label,
        quantity,
        iconPath: iconPath || slot.iconPath,
      };
    });
    if (taughtCrop) {
      lastScan.unresolved = lastScan.unresolved.filter(
        (slot) => slot.dataUrl !== taughtCrop,
      );
    }
    stopHoverTeach();
    cellTeach = null;
    pendingTeachConfirm = null;
    hoverTeachHint = "";
    showToast(`Learned ${label} from that slot.`, "good");
    render();
    return;
  }

  // Drop unresolved rows whose guess already matches what we just taught.
  lastScan.unresolved = lastScan.unresolved.filter((slot) => slot.guessKey !== key);
  lastScan.nearMisses = lastScan.nearMisses.filter((miss) => {
    const still = lastScan!.unresolved.some((slot) => slot.cell === miss.cell);
    return still;
  });

  // Compact “+” add: no bank cell — append a hit-looking preview tile so it shows up.
  if (COMPACT_SCAN_PREVIEW && !taughtCell) {
    const iconPath = iconPathForLearnedKey(key);
    const maxRow = lastScan.debugSlots.reduce((m, s) => Math.max(m, s.row), -1);
    lastScan.debugSlots.push({
      row: maxRow + 1,
      column: 0,
      key: (() => {
        const parsed = parseLearnedKey(key);
        if (!parsed) return key;
        return parsed.type === "artefact"
          ? `${parsed.id}:${parsed.kind}`
          : `mat:${parsed.id}`;
      })(),
      name: label,
      quantity,
      iconPath: iconPath || "",
      kind: "hit",
      cropDataUrl: dataUrl,
    });
    if (hit) {
      const existing = lastScan.hits.find((other) => learnedKeyForHit(other) === key);
      if (existing && existing.quantity < quantity) existing.quantity = quantity;
    }
    hoverTeachHint = "";
    showToast(`Added ${label}.`, "good");
    render();
    return;
  }

  hoverTeachHint = `Learned ${label}. Hover another unmatched icon, or stop hover teach.`;
  showToast(`Learned ${label} from tooltip.`, "good");
  render();
};

const cellScreenGate = (
  scan: ScanResult,
  row: number,
  column: number,
): { gate: import("./tooltip-teach").CellTeachGate; onScreen: boolean } | null => {
  const lattice = scan.latticeCentres;
  const origin = scan.stitchScreenOrigin;
  const cropUrl = scan.debugSlots.find(
    (slot) => slot.row === row && slot.column === column && slot.cropDataUrl,
  )?.cropDataUrl;
  if (!lattice || !origin || !cropUrl) return null;
  const cx = lattice.columns[column];
  const cy = lattice.rows[row];
  if (cx === undefined || cy === undefined) return null;

  // Map stitch-image coordinates → current screen: the live viewport shows the
  // bottom `viewportH` of the stitch after a scroll capture.
  const stitchH =
    scan.searchArea?.height ||
    scan.stitchHeightBeforeTrim ||
    scan.stitchViewportHeight ||
    0;
  const viewportH = scan.stitchViewportHeight || stitchH;
  const offsetY = Math.max(0, stitchH - viewportH);
  // Exact slot bounds — padding made neighbouring icons count as “this” cell.
  const screenLeft = Math.round(origin.x + cx - lattice.cellWidth / 2);
  const screenTop = Math.round(origin.y + cy - offsetY - lattice.cellHeight / 2);
  const onScreen =
    cy >= offsetY - lattice.cellHeight * 0.55 &&
    cy <= offsetY + viewportH + lattice.cellHeight * 0.55;

  return {
    onScreen,
    gate: {
      row,
      column,
      screenLeft,
      screenTop,
      screenWidth: Math.round(lattice.cellWidth),
      screenHeight: Math.round(lattice.cellHeight),
      cropDataUrl: cropUrl,
    },
  };
};

const startCellTeach = (row: number, column: number): void => {
  if (!lastScan) return;
  if (pendingTeachConfirm) {
    showToast("Confirm or cancel the pending name first.", "error");
    return;
  }
  const mapped = cellScreenGate(lastScan, row, column);
  if (!mapped) {
    showToast("That cell has no icon crop to teach.", "error");
    return;
  }

  if (!mapped.onScreen) {
    const place = storagePlaceLabel(lastScan.interfaceKind);
    showToast(
      `That icon isn’t in the current ${place} view. Scroll to it and scan again, or pick a cell that’s still on screen.`,
      "error",
    );
    return;
  }

  stopHoverTeach();
  pendingTeachConfirm = null;
  cellTeach = { row, column };
  const place = storagePlaceLabel(lastScan.interfaceKind);
  // Teach is for misses / wrong names — identity comes from hover OCR.
  hoverTeachHint = `Hover that ${place} slot — watch for the name in the top-left of the game.`;
  showToast(`Teaching — hover the matching ${place} slot.`);
  render();

  const updateTeachHud = (message: string): void => {
    hoverTeachHint = message;
    const live = document.querySelector("#teach-hud-live");
    if (live) live.textContent = message;
  };

  try {
    startCellHoverTeach(
      mapped.gate,
      {
        onTaught: (taught) => {
          stopHoverTeach();
          pendingTeachConfirm = {
            key: taught.key,
            label: taught.label,
            dataUrl: taught.dataUrl,
            row,
            column,
            trackable: taught.trackable,
          };
          cellTeach = null;
          hoverTeachHint = "";
          showToast(
            taught.trackable
              ? `Captured “${taught.label}” — confirm to learn it.`
              : `Read “${taught.label}” — not a trackable item.`,
            taught.trackable ? "detect" : "error",
          );
          render();
        },
        onStatus: updateTeachHud,
        onHud: updateTeachHud,
      },
      undefined,
      place,
    );
  } catch (error) {
    stopHoverTeach();
    cellTeach = null;
    hoverTeachHint = "";
    showToast(
      error instanceof Error ? error.message : "Could not start cell teach.",
      "error",
    );
    render();
  }
};

const cancelCellTeach = (): void => {
  stopHoverTeach();
  cellTeach = null;
  pendingTeachConfirm = null;
  hoverTeachHint = "";
  showToast("Cell teach cancelled.");
  render();
};

const applyManualTeachName = (): void => {
  if (!lastScan || !cellTeach) return;
  const select = document.querySelector<HTMLSelectElement>("#teach-name-pick");
  const key = select?.value?.trim() ?? "";
  if (!key) {
    showToast("Pick an item name first.", "error");
    return;
  }
  const parsed = parseLearnedKey(key);
  if (!parsed) {
    showToast("That name isn’t valid.", "error");
    return;
  }
  const mapped = cellScreenGate(lastScan, cellTeach.row, cellTeach.column);
  if (!mapped) {
    showToast("That cell has no icon crop to teach.", "error");
    return;
  }

  let label = key;
  if (parsed.type === "material") {
    label =
      archaeologyData.materials.find((entry) => entry.id === parsed.id)?.name ??
      key;
  } else {
    const artefact = archaeologyData.artefacts.find(
      (entry) => entry.id === parsed.id,
    );
    label = artefact ? `${artefact.name} (${parsed.kind})` : key;
  }

  stopHoverTeach();
  pendingTeachConfirm = {
    key,
    label,
    dataUrl: mapped.gate.cropDataUrl,
    row: cellTeach.row,
    column: cellTeach.column,
    trackable: true,
  };
  cellTeach = null;
  hoverTeachHint = "";
  showToast(`Selected “${label}” — confirm to learn it.`);
  render();
};

const ignoreCellTeach = (): void => {
  if (!lastScan) return;
  const taught = pendingTeachConfirm
    ? { row: pendingTeachConfirm.row, column: pendingTeachConfirm.column }
    : cellTeach;
  if (!taught) return;
  const miss = lastScan.debugSlots.find(
    (slot) =>
      slot.row === taught.row &&
      slot.column === taught.column &&
      slot.kind === "miss",
  );
  const hit = lastScan.debugSlots.find(
    (slot) =>
      slot.row === taught.row &&
      slot.column === taught.column &&
      slot.kind === "hit",
  );
  if (!miss?.cropDataUrl && !hit) {
    showToast("That slot can’t be ignored.", "error");
    return;
  }
  const unresolvedIndex = miss?.cropDataUrl
    ? lastScan.unresolved.findIndex((slot) => slot.dataUrl === miss.cropDataUrl)
    : -1;
  stopHoverTeach();
  cellTeach = null;
  pendingTeachConfirm = null;
  hoverTeachHint = "";
  if (unresolvedIndex >= 0) {
    ignoreUnresolved(unresolvedIndex);
    return;
  }
  if (miss?.cropDataUrl) {
    const signature = miss.key.startsWith("miss:") ? miss.key.slice(5) : miss.key;
    addIgnored(signature);
  }
  lastScan.debugSlots = lastScan.debugSlots.filter(
    (slot) => !(slot.row === taught.row && slot.column === taught.column),
  );
  showToast("Ignored — that icon will not be listed again.", "bad");
  render();
};

const confirmPendingTeach = (): void => {
  const pending = pendingTeachConfirm;
  if (!pending?.trackable || !pending.key) {
    showToast("That isn’t a trackable item — ignore the slot instead.", "error");
    return;
  }
  void learnFromHover(pending.key, pending.label, pending.dataUrl);
};

const cancelPendingTeachConfirm = (): void => {
  const pending = pendingTeachConfirm;
  pendingTeachConfirm = null;
  hoverTeachHint = "";
  if (pending) {
    // Resume hover teach on the same cell so they can try another tooltip.
    startCellTeach(pending.row, pending.column);
    showToast("Cancelled — hover the slot again when ready.");
    return;
  }
  render();
};

const startCompactAddItem = (): void => {
  if (isHoverTeachActive()) {
    stopHoverTeach();
    hoverTeachHint = "";
    showToast("Add cancelled.");
    render();
    return;
  }
  cellTeach = null;
  pendingTeachConfirm = null;
  hoverTeachHint = "Hover the missed item in your bank — watch for the name in the top-left.";
  showToast("Hover the item in your bank to add it.");
  startHoverTeach(
    (taught) => {
      stopHoverTeach();
      hoverTeachHint = "";
      void learnFromHover(taught.key, taught.label, taught.dataUrl);
    },
    (message) => {
      hoverTeachHint = message;
      const live = document.querySelector("#teach-hud-live");
      if (live) live.textContent = message;
    },
  );
  render();
};

const toggleHoverTeach = (): void => {
  if (isHoverTeachActive()) {
    stopHoverTeach();
    hoverTeachHint = "";
    cellTeach = null;
    pendingTeachConfirm = null;
    showToast("Hover teach stopped.");
    render();
    return;
  }
  startHoverTeach(
    (taught) => {
      void learnFromHover(taught.key, taught.label);
    },
    (message) => {
      hoverTeachHint = message;
      const hint = document.querySelector(".teach-hover .scan-hint");
      if (hint) hint.textContent = message;
    },
  );
  render();
};

// Marks a slot as something this app does not track, so it stops being reported.
const ignoreUnresolved = (index: number): void => {
  if (!lastScan) return;
  const slot = lastScan.unresolved[index];
  if (!slot) return;

  addIgnored(slot.signature);
  const ignoredCell = slot.cell;
  lastScan.unresolved.splice(index, 1);
  lastScan.nearMisses = lastScan.nearMisses.filter((miss) => miss.cell !== ignoredCell);
  if (!lastScan.unresolved.length) lastScan.nearMisses = [];
  showToast("Ignored — that icon will not be listed again.", "bad");
  render();
};

const ensureCompanionWatcherRunning = async (): Promise<void> => {
  if (companionWatcher?.running || companionWatcherStarting) {
    syncCompanionModeTimer();
    return;
  }

  const status = getAlt1Status();
  // Pixel permission is enough to capture; rsLinked can flap and was
  // leaving the watcher stuck on "off" / flashing the mode card.
  if (!status.available || !status.pixelPermission) {
    syncCompanionModeTimer();
    return;
  }

  companionWatcherStarting = true;
  syncCompanionModeTimer();
  try {
    void ensureMaterialPrices();
    if (!companionWatcher) {
      const { CompanionWatcher } = await import("./companion-watcher");
      companionWatcher = new CompanionWatcher(
        (event) => {
          if (event.type === "artefact") {
            const current = getCount(state, event.artefact.id).damaged;
            setCount(state, event.artefact.id, "damaged", current + event.quantity);
            showToast(
              `Found ${event.artefact.name} (+${event.quantity} damaged).`,
              "good",
            );
          } else if (event.type === "tetracompass") {
            const current = getTetraPiece(state, event.piece);
            setTetraPiece(state, event.piece, current + event.quantity);
            showToast(
              `Found ${tetraPieceLabel(event.piece)} (+${event.quantity}).`,
              "good",
            );
          } else {
            const current = getMaterial(state, event.material.id);
            setMaterial(state, event.material.id, current + event.quantity);
            showToast(
              `Excavated ${event.material.name} (+${event.quantity}).`,
              "good",
            );
          }
          void recordWatcherFindValue(event).then(() => {
            syncExcavationRateTimer();
            refreshExcavationRateCard();
            refreshCompanionModeCard();
          });
          // Inventory counts live in state — redraw so Inventory/Overview stay in sync.
          render();
          syncCompanionModeTimer();
        },
        (event) => {
          const { applied, materials } = applyRestoredArtefacts(
            event.artefact,
            event.quantity,
          );
          if (!applied) {
            showToast(
              `Saw restore of ${event.artefact.name} (${event.progress}), but no damaged copies were tracked.`,
              "error",
            );
            lastRestoreToastAt = Date.now();
            refreshCompanionModeCard();
            return;
          }
          const matNote = materials.length
            ? ` · materials withdrawn from inventory: ${materials
                .map((m) => `${m.quantity}× ${m.name}`)
                .join(", ")}`
            : event.artefact.materials.some(
                  (entry) => !entry.name.includes("(damaged)"),
                )
              ? " · (no tracked materials to withdraw)"
              : "";
          showToast(
            applied === 1
              ? `Restored ${event.artefact.name} (−1 damaged${matNote})`
              : `Restored ${applied}× ${event.artefact.name} (−${applied} damaged${matNote})`,
            "bad",
          );
          // Keep this toast visible — status probes must not overwrite it.
          lastRestoreToastAt = Date.now();
          render();
          syncCompanionModeTimer();
        },
        (status) => {
          // Don't clobber a fresh "Restored…" inventory toast with probe status.
          if (Date.now() - lastRestoreToastAt < 2500) {
            refreshCompanionModeCard();
            return;
          }
          if (status.phase === "ready" || status.phase === "restoring") {
            showToast(
              status.artefactName
                ? status.progress
                  ? `Restoring · ${status.artefactName} ${status.progress}`
                  : `Restoring · ${status.artefactName}`
                : status.message || "Restoration window detected.",
              "detect",
            );
          } else if (/^Restore:|^Looking for restoration/i.test(status.message)) {
            showToast(status.message, "detect");
          }
          refreshCompanionModeCard();
        },
        (message) => {
          // Near-miss paper toasts are noise when idle (dirt / UI false paper).
          // Only surface them while excavating, and throttle repeats.
          if (/Artefact popup: paper ok/i.test(message)) {
            if (isDevToolsActive() && companionWatcher?.modeName === "excavate") {
              const short = message.replace(/^Artefact popup:\s*/i, "Popup: ");
              if (short !== lastPopupMissToast) {
                lastPopupMissToast = short;
                lastPopupMissToastAt = Date.now();
                showToast(short, "detect");
              } else if (Date.now() - lastPopupMissToastAt > 8_000) {
                lastPopupMissToastAt = Date.now();
                showToast(short, "detect");
              }
            }
            console.info(message);
            return;
          }
          console.info(message);
        },
      );
    }
    companionWatcher.start();
    syncCompanionModeTimer();
  } catch (error) {
    companionWatcher = null;
    showToast(
      error instanceof Error
        ? error.message
        : "Couldn’t start the companion watcher.",
      "error",
    );
  } finally {
    companionWatcherStarting = false;
    syncCompanionModeTimer();
  }
};

/* ---------------------------------------------------------------- events */

const finishScanWizard = (toast?: string): void => {
  state.scanWizardComplete = true;
  saveStateNow(state);
  wizardSkipped.clear();
  view = "inventory";
  if (toast) showToast(toast);
  render();
};

const completeSetup = (): void => {
  state.setupComplete = true;
  resetScanWizardProgress(state);
  wizardSkipped.clear();
  lastScan = null;
  saveStateNow(state);
  render();
};

const refresh = (selector: string, markup: () => string): void => {
  const container = document.querySelector(selector);
  if (container) container.innerHTML = markup();
};

const markOwned = (selector: string, owned: boolean): void => {
  document.querySelector(selector)?.classList.toggle("owned", owned);
};

const loadHiscores = async (
  nameSelector: string, button: HTMLButtonElement, thenSetup: boolean,
): Promise<void> => {
  const name = document.querySelector<HTMLInputElement>(nameSelector)!.value.trim();
  if (!name) {
    showToast("Enter your RuneScape display name first.", "error");
    return;
  }

  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Loading…";

  try {
    const result = await fetchArchaeologyHiscore(name);
    state.displayName = name;
    state.level = Math.min(120, result.level);
    state.xp = result.xp;
    saveStateNow(state);
    showToast(`Loaded level ${state.level} from ${result.source}.`, "good");
    if (thenSetup) completeSetup();
    else render();
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    showToast(error instanceof Error ? error.message : "Could not load hiscores.", "error");
  }
};

const readProfileFields = (nameId: string, levelId: string, xpId: string): void => {
  state.displayName = document.querySelector<HTMLInputElement>(nameId)!.value.trim();
  state.level = Math.max(1, Math.min(120, Number(document.querySelector<HTMLInputElement>(levelId)!.value)));
  state.xp = Math.max(0, Number(document.querySelector<HTMLInputElement>(xpId)!.value));
};

// One delegated listener per event type, bound once. Rebinding per render was
// stacking thousands of listeners on the artefact list and locking the app up.
const handleClick = (event: MouseEvent): void => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const teachCell = target.closest<HTMLElement>("[data-teach-cell]");
  if (teachCell) {
    event.preventDefault();
    event.stopPropagation();
    const row = Number(teachCell.dataset.row);
    const column = Number(teachCell.dataset.col);
    if (Number.isFinite(row) && Number.isFinite(column)) {
      startCellTeach(row, column);
    }
    return;
  }

  const button = target.closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  const {
    view: viewName, adjust, materialAdjust, collapse, filter,
    theme, kind, delta, favorite, tetraAdjust,
  } = button.dataset;

  if (favorite) {
    toggleFavorite(favorite);
    render();
  } else if (viewName) {
    if (viewName === "scan" || viewName === "artefacts" || viewName === "materials") {
      view = "inventory";
      if (viewName === "artefacts" || viewName === "materials") {
        inventorySection = viewName;
      }
    } else {
      view = viewName as ViewName;
    }
    render();
  } else if (button.dataset.inventorySection === "artefacts" || button.dataset.inventorySection === "materials") {
    inventorySection = button.dataset.inventorySection;
    render();
  } else if (adjust) {
    const countKind = kind as "damaged" | "restored";
    const next = setCount(state, adjust, countKind, getCount(state, adjust)[countKind] + Number(delta));
    const input = document.querySelector<HTMLInputElement>(`input[data-count="${adjust}"][data-kind="${countKind}"]`);
    if (input) input.value = String(next);
    const count = getCount(state, adjust);
    markOwned(`[data-row="${adjust}"]`, count.damaged + count.restored > 0);
  } else if (materialAdjust) {
    const next = setMaterial(state, materialAdjust, getMaterial(state, materialAdjust) + Number(delta));
    const input = document.querySelector<HTMLInputElement>(`input[data-material-count="${materialAdjust}"]`);
    if (input) input.value = String(next);
    markOwned(`[data-material-row="${materialAdjust}"]`, next > 0);
  } else if (tetraAdjust) {
    const piece = tetraAdjust as TetraPieceId;
    if (!TETRA_PIECE_IDS.includes(piece)) return;
    const next = setTetraPiece(
      state,
      piece,
      getTetraPiece(state, piece) + Number(delta),
    );
    const input = document.querySelector<HTMLInputElement>(
      `input[data-tetra-count="${piece}"]`,
    );
    if (input) input.value = String(next);
    markOwned(`[data-tetra-row="${piece}"]`, next > 0);
    if (view === "dashboard") render();
    else if (view === "inventory" && inventorySection === "artefacts") {
      refresh("#artefact-groups", renderArtefactGroups);
    }
  } else if (button.id === "assemble-tetra") {
    if (assembleTetraCompass(state)) {
      showToast("Marked one tetracompass assembled (−1 of each piece).", "bad");
      render();
    }
  } else if (collapse) {
    if (collapsed.has(collapse)) collapsed.delete(collapse);
    else collapsed.add(collapse);
    if (collapse.startsWith("overview:")) render();
    else if (collapse.startsWith("material:")) refresh("#material-list", renderMaterialRows);
    else refresh("#artefact-groups", renderArtefactGroups);
  } else if (filter) {
    collectionFilter = filter;
    render();
  } else if (button.id === "force-idle-mode") {
    companionWatcher?.resumeIdle();
    showToast("Watcher forced to idle");
    refreshCompanionModeCard();
  } else if (button.id === "stop-scan") {
    finishLiveScan();
  } else if (theme) {
    state.theme = theme as PlayerState["theme"];
    saveStateNow(state);
    render();
  } else if (button.dataset.entryMode) {
    // Keep typed setup name when flipping mode on the splash screen.
    const nameField = document.querySelector<HTMLInputElement>("#setup-name");
    if (nameField) state.displayName = nameField.value.trim();
    state.entryMode = button.dataset.entryMode as PlayerState["entryMode"];
    saveStateNow(state);
    render();
  } else if (button.id === "toggle-all-groups") {
    const keys =
      inventorySection === "materials"
        ? MATERIAL_CATEGORIES.map((category) => `material:${category}`)
        : ["culture:Tetracompass", ...CULTURES.map((culture) => `culture:${culture}`)];
    if (keys.some((key) => collapsed.has(key))) keys.forEach((key) => collapsed.delete(key));
    else keys.forEach((key) => collapsed.add(key));
    render();
  } else if (button.id === "start-scan" || button.id === "scan-storage") {
    if (scanBusy) finishLiveScan();
    else startScan();
  } else if (button.id === "add-scan") {
    applyScan();
  } else if (button.id === "discard-scan") {
    stopHoverTeach();
    hoverTeachHint = "";
    cellTeach = null;
    pendingTeachConfirm = null;
    lastScan = null;
    render();
  } else if (button.id === "cancel-cell-teach") {
    cancelCellTeach();
  } else if (button.id === "teach-name-apply") {
    applyManualTeachName();
  } else if (button.id === "ignore-cell-teach") {
    ignoreCellTeach();
  } else if (button.id === "confirm-cell-teach") {
    confirmPendingTeach();
  } else if (button.id === "cancel-cell-teach-confirm") {
    cancelPendingTeachConfirm();
  } else if (button.id === "compact-add-item") {
    startCompactAddItem();
  } else if (button.id === "hover-teach") {
    toggleHoverTeach();
  } else if (button.dataset.teachSave) {
    void learnUnresolved(Number(button.dataset.teachSave));
  } else if (button.dataset.teachIgnore) {
    ignoreUnresolved(Number(button.dataset.teachIgnore));
  } else if (button.id === "forget-ignored") {
    if (!confirmDestructive("forget-ignored", "Clear all ignored icons?")) return;
    clearIgnored();
    showToast("Ignored icons cleared.", "bad");
    render();
  } else if (button.id === "forget-learned") {
    if (!confirmDestructive("forget-learned", "Clear all taught icons?")) return;
    clearLearned();
    void import("./scanner").then(({ clearTargetCache }) => clearTargetCache());
    showToast("Taught icons cleared.", "bad");
    render();
  } else if (button.id === "goto-manual") {
    state.entryMode = "manual";
    saveStateNow(state);
    view = "inventory";
    inventorySection = "artefacts";
    render();
  } else if (button.id === "setup-load") {
    void loadHiscores("#setup-name", button, true);
  } else if (button.id === "setup-toggle") {
    // Keep whatever was typed so re-rendering the card does not wipe it.
    state.displayName = document.querySelector<HTMLInputElement>("#setup-name")!.value.trim();
    manualSetup = !manualSetup;
    render();
  } else if (button.id === "setup-manual") {
    readProfileFields("#setup-name", "#setup-level", "#setup-xp");
    completeSetup();
  } else if (button.id === "hiscore-sync") {
    void loadHiscores("#display-name", button, false);
  } else if (button.id === "save-profile") {
    readProfileFields("#display-name", "#manual-level", "#manual-xp");
    saveStateNow(state);
    showToast("Profile saved.", "detect");
    render();
  } else if (button.id === "rescan-storage") {
    if (!confirmDestructive(
      "rescan-storage",
      "Clear all saved artefacts and materials, then run the storage scan again?",
    )) return;
    state.inventory = {};
    state.materials = {};
    state.tetraPieces = emptyTetraPieces();
    // Keep profile, favourites, theme, and taught icons — only re-scan storage.
    resetScanWizardProgress(state);
    wizardSkipped.clear();
    lastScan = null;
    saveStateNow(state);
    render();
  } else if (button.id === "wizard-skip-step") {
    const step = nextWizardStep();
    if (step) wizardSkipped.add(step);
    lastScan = null;
    render();
  } else if (button.id === "wizard-skip-all") {
    for (const step of WIZARD_STEPS) {
      if (!state.scanWizardDone[step]) wizardSkipped.add(step);
    }
    lastScan = null;
    render();
  } else if (button.id === "wizard-finish") {
    finishScanWizard();
  } else if (button.id === "export-data") {
    exportState(state);
    showToast("Backup exported.", "detect");
  }
};

const handleChange = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;

  if (input.dataset.count) {
    const id = input.dataset.count;
    const next = setCount(state, id, input.dataset.kind as "damaged" | "restored", Number(input.value));
    input.value = String(next);
    const count = getCount(state, id);
    markOwned(`[data-row="${id}"]`, count.damaged + count.restored > 0);
  } else if (input.dataset.materialCount) {
    const next = setMaterial(state, input.dataset.materialCount, Number(input.value));
    input.value = String(next);
    markOwned(`[data-material-row="${input.dataset.materialCount}"]`, next > 0);
  } else if (input.dataset.tetraCount) {
    const piece = input.dataset.tetraCount as TetraPieceId;
    if (!TETRA_PIECE_IDS.includes(piece)) return;
    const next = setTetraPiece(state, piece, Number(input.value));
    input.value = String(next);
    markOwned(`[data-tetra-row="${piece}"]`, next > 0);
    if (view === "dashboard") render();
    else if (view === "inventory" && inventorySection === "artefacts") {
      refresh("#artefact-groups", renderArtefactGroups);
    }
  } else if (input.id === "compact-toggle") {
    state.compact = input.checked;
    saveStateNow(state);
    render();
  } else if (input.id === "dev-mode-toggle") {
    if (!ENABLE_DEV_TOOLS) return;
    state.devMode = input.checked;
    setDevModeEnabled(state.devMode);
    saveStateNow(state);
    if (!state.devMode) {
      void import("./restore-watcher").then(({ clearRestoreOutlinesForDev }) => {
        clearRestoreOutlinesForDev();
      });
    }
    syncCompanionModeTimer();
    render();
  } else if (input.id === "import-data") {
    const file = input.files?.[0];
    if (!file) return;
    try {
      state = await importState(file);
      setDevModeEnabled(state.devMode);
      showToast("Backup imported.", "good");
      render();
    } catch {
      showToast("That file is not a valid companion backup.", "error");
    }
  }
};

const handleInput = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  const isArtefactSearch = input.id === "artefact-search";
  if (!isArtefactSearch && input.id !== "material-search") return;

  if (isArtefactSearch) search = input.value;
  else materialSearch = input.value;

  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    if (isArtefactSearch) refresh("#artefact-groups", renderArtefactGroups);
    else refresh("#material-list", renderMaterialRows);
  }, 160);
};

app.addEventListener("click", handleClick);
app.addEventListener("change", (event) => void handleChange(event));
app.addEventListener("input", handleInput);
window.addEventListener("beforeunload", () => saveStateNow(state));

identifyAlt1App();
render();

// Hydrate local GE prices, then refresh all materials once this session.
{
  const priceVersionBefore = getPriceVersion();
  void ensureMaterialPrices().then(() => {
    if (getPriceVersion() === priceVersionBefore) return;
    render();
  });
}
