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
  materialIcon,
  uiIcon,
} from "./data";
import { fetchArchaeologyHiscore } from "./hiscores";
import {
  exportState,
  getCount,
  getMaterial,
  importState,
  loadState,
  saveStateNow,
  setCount,
  setMaterial,
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
import type { ExcavationWatcher } from "./watcher";
import { excavationSnapshot, noteExcavationValue } from "./excavation-session";
import {
  ensureMaterialPrices,
  ensurePriceForName,
  formatGp,
  priceForName,
} from "./prices";
import type {
  Artefact, Collection, MaterialInfo, PlayerState, ViewName,
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
let state: PlayerState = loadState();

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
} | null = null;
let scanBusy = false;
let scanMessage = "";
let scanLive = false;
let scanStopRequested = false;
let scanPasses = 0;
let watcher: ExcavationWatcher | null = null;
let watcherStarting = false;
let excavationRateTimer: number | undefined;
let manualSetup = false;
const collapsed = new Set<string>();
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
  showToast(`${prompt} Click again to confirm.`, "bad");
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

const showToast = (message: string, kind: "good" | "bad" = "good"): void => {
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

const renderSetup = (): string => `
  <main class="setup">
    <section class="setup-card">
      ${img(uiIcon("journal"), "setup-icon")}
      <h2>Welcome, archaeologist</h2>
      <p>Tell the app who you are and it will load your exact Archaeology level and XP, then only show collections you can actually complete.</p>
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
          <button type="button" class="mode-chip ${state.entryMode === "auto" ? "active" : ""}" data-entry-mode="auto">
            <strong>Auto</strong>
            <small>Scan fills counts · no +/−</small>
          </button>
          <button type="button" class="mode-chip ${state.entryMode === "manual" ? "active" : ""}" data-entry-mode="manual">
            <strong>Manual</strong>
            <small>Type with +/− steppers</small>
          </button>
        </div>
      </div>
      <p class="setup-note">Everything is stored on this computer only. You can change this later in Settings.</p>
    </section>
  </main>`;

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
): string => {
  const { collection } = progress;
  const chronotes = progress.completeSets ? progress.totalChronotes : collection.artefactChronotes + collection.bonusChronotes;
  const chronotesLabel = `chronotes${progress.completeSets ? " owned" : " per set"}`;
  const filled = collection.artefacts.length - progress.missing.length;
  const recurring =
    collection.recurringReward && collection.recurringReward.name !== "No"
      ? collection.recurringReward
      : null;
  const reason = options?.reason ?? "chronotes";

  let primaryValue: string;
  let primaryLabel: string;
  let secondary = "";
  let iconKey = "chronotes";

  if (reason === "tetracompass" && collection.tetracompassPieces > 0) {
    iconKey = "tetracompass";
    const pieces = progress.completeSets
      ? progress.totalTetracompassPieces
      : collection.tetracompassPieces;
    primaryValue = formatNumber(pieces);
    primaryLabel = `tetra piece${pieces === 1 ? "" : "s"} / set`;
    secondary = `<small>${formatNumber(chronotes)} ${chronotesLabel}</small>`;
  } else if (reason === "other" && recurring) {
    iconKey = "archaeology";
    const qty = progress.completeSets
      ? recurring.quantity * progress.completeSets
      : recurring.quantity;
    primaryValue = formatNumber(qty);
    primaryLabel = `${recurring.name}${progress.completeSets ? " owned" : " / set"}`;
    secondary = `<small>${formatNumber(chronotes)} ${chronotesLabel}</small>`;
  } else {
    primaryValue = formatNumber(chronotes);
    primaryLabel = chronotesLabel;
    if (collection.tetracompassPieces > 0) {
      secondary = `<small>+${collection.tetracompassPieces} tetra / set</small>`;
    } else if (recurring) {
      secondary = `<small>+${recurring.quantity} ${esc(recurring.name)} / set</small>`;
    }
  }

  return `
    <article class="recommendation ${progress.completeSets ? "ready" : ""}">
      <div class="reward-icon">${img(uiIcon(iconKey), "item-icon")}</div>
      <div class="recommendation-main">
        <div class="title-line">
          <h3>${esc(collection.name)}</h3>
          ${favoriteStarButton(collection.id, true)}
          ${progress.completeSets ? `<span class="ready-badge">${progress.completeSets} set${progress.completeSets === 1 ? "" : "s"}</span>` : ""}
        </div>
        <p>${esc(collection.collector)} · Level ${collection.level} · ${collection.artefacts.length} artefacts${options?.label ? ` · <strong>${esc(options.label)}</strong>` : ""}</p>
        <div class="mini-progress"><span style="width:${(filled / collection.artefacts.length) * 100}%"></span></div>
      </div>
      <div class="reward-summary">
        <strong>${primaryValue}</strong>
        <span>${esc(primaryLabel)}</span>
        ${secondary}
      </div>
    </article>`;
};

const renderScanControls = (): string => {
  const status = getAlt1Status();
  const canScan = status.pixelPermission && status.linked;
  const capturing = scanBusy && scanLive && !scanStopRequested;
  const finishing = scanBusy && (!scanLive || scanStopRequested);
  const scanDisabled = !canScan || finishing;
  const scanLabel = capturing || finishing ? "Finish" : "Scan";
  const scanHint = scanBusy
    ? esc(scanMessage)
    : "Bank, workbench, or material storage.";

  return `
    <section class="scan-options single">
      <article>
        ${img(uiIcon("magnifying-glass"), "scan-icon")}
        <div class="scan-option-body">
          <h3>Scan storage</h3>
          <p class="scan-live-status">${scanHint}</p>
          ${!canScan && !scanBusy ? `<p class="scan-hint">${esc(status.message)}</p>` : ""}
          ${capturing ? `<p class="scan-hint">Scroll only if more items are off-screen. When the list looks complete, press Finish.</p>` : ""}
          <button class="${capturing ? "secondary-button" : "gold-button"} scan-option-btn" id="start-scan" ${scanDisabled ? "disabled" : ""}>${scanLabel}</button>
        </div>
      </article>
    </section>`;
};

const renderExcavationRate = (): string => {
  const snap = excavationSnapshot();
  if (!snap.excavating || snap.gpPerHour === null) {
    return `
      <article class="stat-card excavation-rate" id="excavation-rate">
        <span>Excavation value</span>
        <strong class="muted-stat">Not currently excavating</strong>
        <small>GE value of materials from chat finds</small>
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

const syncExcavationRateTimer = (): void => {
  const excavating = excavationSnapshot().excavating;
  if (excavating && excavationRateTimer === undefined) {
    excavationRateTimer = window.setInterval(refreshExcavationRateCard, 1_000);
  } else if (!excavating && excavationRateTimer !== undefined) {
    window.clearInterval(excavationRateTimer);
    excavationRateTimer = undefined;
  }
};

const recordWatcherFindValue = async (
  event: import("./watcher").WatcherEvent,
): Promise<void> => {
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

const renderDashboard = (): string => {
  const ready = progressList().filter((progress) => progress.completeSets > 0);
  const opportunities = bestCollectionOpportunities(state);
  const favorites = state.favoriteCollections
    .map((id) => archaeologyData.collections.find((collection) => collection.id === id))
    .filter((collection): collection is Collection => Boolean(collection))
    .map((collection) => getCollectionProgress(collection, state));

  return `
    <main>
      ${renderScanControls()}
      ${renderScanResults()}
      <section class="stats-grid">
        ${renderExcavationRate()}
        <article class="stat-card"><span>Owned artefacts</span><strong>${formatNumber(ownedTotal())}</strong><small>damaged + restored</small></article>
        <article class="stat-card"><span>Restoration XP</span><strong>${formatNumber(pendingXp())}</strong><small>available from damaged</small></article>
        <article class="stat-card"><span>Ready collections</span><strong>${ready.length}</strong><small>at least one full set</small></article>
      </section>
      <section class="panel">
        <div class="panel-heading"><div><span class="eyebrow">${favorites.length ? `${favorites.length} pinned` : "Pin collections you care about"}</span><h2>Favourites</h2></div><button class="text-button" data-view="collections">Browse</button></div>
        <div class="recommendations">
          ${favorites.length
            ? favorites.map((progress) => renderRecommendation(progress)).join("")
            : `<div class="empty">No favourites yet. Open Collections and tap the star on a collection to pin it here.</div>`}
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><div><span class="eyebrow">For level ${state.level}</span><h2>Recommended collections</h2></div><button class="text-button" data-view="collections">View all</button></div>
        <p class="scan-hint">One pick each for chronotes, tetracompass pieces, and ${state.level >= 77 ? "dung tokens" : "another recurring reward"} at your level.</p>
        <div class="recommendations">
          ${opportunities.length
            ? opportunities.map((entry) => renderRecommendation(entry.progress, { label: entry.label, reason: entry.reason })).join("")
            : `<div class="empty">No collections available at this level yet.</div>`}
        </div>
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
  return `Lv ${artefact.level} · Dig sites: ${sites}`;
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

  if (!groups.length) return `<div class="empty">No artefacts match that search.</div>`;

  return groups.map((group) => {
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
};

const renderArtefactPanel = (): string => `
  <div class="toolbar">
    <label class="search"><span>⌕</span><input id="artefact-search" type="search" placeholder="Search artefacts or cultures…" value="${esc(search)}"></label>
    <button class="secondary-button" id="toggle-all-groups">Collapse all</button>
  </div>
  <p class="list-hint">Hover an artefact to see its dig sites.${isManual() ? "" : " Switch to Manual in Settings to edit counts with +/−."}</p>
  <section id="artefact-groups" class="groups">${renderArtefactGroups()}</section>`;

/* ------------------------------------------------------------- materials */

const renderMaterialTile = (material: MaterialInfo): string => {
  const stored = getMaterial(state, material.id);
  const uses = `used in ${material.usedInArtefacts} artefact${material.usedInArtefacts === 1 ? "" : "s"}`;
  return `
    <article class="slot-tile material-slot ${stored ? "owned" : ""} ${isManual() ? "manual" : "auto"}" data-material-row="${material.id}" title="${esc(material.name)} · ${uses}">
      ${img(materialIcon(material.id), "slot-icon")}
      <div class="slot-body">
        <strong>${esc(material.name)}</strong>
        <div class="slot-counts single">${materialQuantity(material.id, stored, material.name)}</div>
      </div>
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

const renderMaterialPanel = (): string => {
  const digMaterials = archaeologyMaterials();
  const stored = digMaterials.reduce(
    (total, material) => total + getMaterial(state, material.id),
    0,
  );
  return `
    <p class="scan-hint">${digMaterials.length} dig materials · ${formatNumber(stored)} stored.${isManual() ? " Adjust with +/−, or scan storage." : " Counts update from scans. Switch to Manual in Settings to edit with +/−."} Shop items (ink, gems, bars…) are not tracked.</p>
    <div class="toolbar">
      <label class="search"><span>⌕</span><input id="material-search" type="search" placeholder="Search materials…" value="${esc(materialSearch)}"></label>
      <button class="secondary-button" id="toggle-all-groups">Collapse all</button>
    </div>
    <section id="material-list" class="groups">${renderMaterialRows()}</section>`;
};

const renderInventory = (): string => `
  <main>
    <div class="filter-row" role="tablist" aria-label="Inventory section">
      <button type="button" data-inventory-section="artefacts" class="${inventorySection === "artefacts" ? "active" : ""}">Artefacts</button>
      <button type="button" data-inventory-section="materials" class="${inventorySection === "materials" ? "active" : ""}">Materials</button>
    </div>
    ${inventorySection === "artefacts" ? renderArtefactPanel() : renderMaterialPanel()}
  </main>`;

/* ----------------------------------------------------------- collections */

const hasDungTokenReward = (collection: Collection): boolean =>
  Boolean(collection.recurringReward?.name.toLowerCase().includes("dungeoneering"));

const renderCollectionCard = (collection: Collection): string => {
  const progress = getCollectionProgress(collection, state);
  const locked = collection.level > state.level;
  const perSet = collection.artefactChronotes + collection.bonusChronotes;
  const fav = isFavorite(collection.id);
  const recurring =
    collection.recurringReward && collection.recurringReward.name !== "No"
      ? collection.recurringReward
      : null;
  return `
    <article class="collection-card ${progress.completeSets ? "ready" : ""} ${locked ? "locked" : ""} ${fav ? "favorited" : ""}">
      <div class="collection-top">
        <div><span class="eyebrow">${esc(collection.collector)} · Level ${collection.level}</span><h3>${esc(collection.name)}</h3></div>
        <div class="collection-top-actions">
          ${favoriteStarButton(collection.id)}
          ${progress.completeSets ? `<div class="set-count"><strong>${progress.completeSets}×</strong><span>sets</span></div>` : ""}
        </div>
      </div>
      <div class="collection-rewards">
        <span>${img(uiIcon("chronotes"), "tiny-icon")}<strong>${formatNumber(progress.completeSets ? progress.totalChronotes : perSet)}</strong>${progress.completeSets ? "owned" : "per set"}</span>
        ${collection.tetracompassPieces ? `<span>${img(uiIcon("tetracompass"), "tiny-icon")}<strong>${progress.completeSets ? progress.totalTetracompassPieces : collection.tetracompassPieces}</strong>tetra</span>` : ""}
        ${recurring && !collection.tetracompassPieces ? `<span><strong>${recurring.quantity}</strong>${esc(recurring.name)}</span>` : ""}
      </div>
      <div class="pieces">${collection.artefacts.map((name) => {
        const artefact = archaeologyData.artefacts.find((item) => item.name === name);
        if (!artefact) return "";
        const count = getCount(state, artefact.id);
        const total = count.damaged + count.restored;
        return `<div class="piece ${total ? "have" : "missing"}" title="${esc(name)}: ${count.damaged} damaged, ${count.restored} restored">
          ${img(artefactIcon(artefact.id), "piece-icon")}<span>${total || "–"}</span>
        </div>`;
      }).join("")}</div>
      <div class="card-footer">
        <span>${collection.artefacts.length - progress.missing.length}/${collection.artefacts.length} restored</span>
        ${progress.potentialSets > progress.restoredSets
          ? `<span class="warning">${progress.potentialSets - progress.restoredSets} set(s) need restoring</span>`
          : progress.completeSets ? `<span class="success">Ready to hand in</span>` : `<span>${progress.missing.length} missing</span>`}
      </div>
    </article>`;
};

const COLLECTION_FILTERS: { id: string; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every collection" },
  { id: "favourites", label: "Favourites", hint: "Collections you starred" },
  { id: "chronotes", label: "Chronotes", hint: "Velucia museum turn-ins — best chronote farms" },
  { id: "tetra", label: "Tetra", hint: "Rewards a tetracompass piece" },
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

/** Shown while teaching a cell or confirming a tooltip name. */
const renderTeachPanel = (scan: ScanResult): string => {
  if (pendingTeachConfirm) {
    const pending = pendingTeachConfirm;
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

  if (cellTeach) {
    const canIgnore = scan.debugSlots.some(
      (slot) =>
        slot.row === cellTeach!.row &&
        slot.column === cellTeach!.column &&
        slot.kind === "miss" &&
        slot.cropDataUrl,
    );
    return `
    <div class="teach-banner" id="teach-hud">
      <p class="teach-banner-live" id="teach-hud-live">${esc(hoverTeachHint || "Hover that bank slot until the tooltip appears.")}</p>
      <div class="teach-banner-pick">
        <select id="teach-name-pick" class="teach-select" aria-label="Pick item name">
          <option value="">Or pick the name…</option>
          ${teachOptions(scan.mode, null)}
        </select>
        <button id="teach-name-apply" class="gold-button">Use name</button>
        <button id="cancel-cell-teach" class="secondary-button">Cancel</button>
        ${canIgnore ? `<button id="ignore-cell-teach" class="secondary-button" title="Not an artefact or material — stop listing this icon">Ignore slot</button>` : ""}
      </div>
    </div>`;
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

const renderCapturedGrid = (scan: ScanResult): string => {
  if (!scan.debugSlots.length && !scan.debugRows) return "";
  // Hits win over misses on the same cell; a miss may still upgrade another miss
  // when it carries a screen crop the earlier one lacked.
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
  const cells: string[] = [];
  const confirmingCell = pendingTeachConfirm;
  for (let row = 0; row < scan.debugRows; row += 1) {
    for (let column = 0; column < scan.debugColumns; column += 1) {
      const slot = byCell.get(`${row},${column}`);
      const teachingThis =
        (cellTeach?.row === row && cellTeach?.column === column) ||
        (confirmingCell?.row === row && confirmingCell?.column === column);

      // Unmatched occupied slots stay blank until clicked for teach.
      if (slot?.kind === "miss" && slot.cropDataUrl) {
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

      if (!slot || slot.kind === "miss") {
        const title = slot
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
  }

  const layoutNote =
    "Missed an item? Click its blank dashed cell. Wrong name? Click the icon. Then hover that slot so its tooltip appears.";

  return `
    <details class="captured-grid-debug" open>
      <summary>Scan Preview</summary>
      <p class="scan-hint">${layoutNote}</p>
      <div class="captured-grid-scroll">
        <div class="captured-grid" style="--debug-columns:${Math.max(1, scan.debugColumns)}">${cells.join("")}</div>
      </div>
    </details>`;
};

const renderStitchPreview = (scan: ScanResult): string => {
  if (!state.debugStitchPreview || !scan.stitchPreviewUrl) return "";
  return `
    <details class="stitch-preview" open>
      <summary>Stitched storage image (${scanPasses} strip(s))</summary>
      <p class="scan-hint">This is the still we matched. Check for duplicate rows or gaps before trusting the found list.</p>
      <div class="stitch-preview-scroll">
        <img class="stitch-preview-img" src="${scan.stitchPreviewUrl}" alt="Stitched storage">
      </div>
      <a class="secondary-button stitch-download" href="${scan.stitchPreviewUrl}" download="storage-stitch.png">Download PNG</a>
    </details>`;
};

const renderScanResults = (): string => {
  if (scanBusy) return "";
  if (!lastScan) return "";
  const teach = renderTeachPanel(lastScan);
  if (!lastScan.hits.length) {
    const debug = renderCapturedGrid(lastScan);
    return `<section class="panel">${teach}<div class="empty">Nothing recognised on screen. Open your bank, workbench or material storage so the items are visible, then scan again.</div>${renderStitchPreview(lastScan)}${debug}</section>`;
  }

  const interfaceLabel = {
    bank: "Bank of Gielinor",
    workbench: "Workbench: damaged only",
    "material-storage": "Material Storage",
  }[lastScan.interfaceKind];
  return `
    <section class="panel">
      ${teach}
      <div class="panel-heading"><div><span class="eyebrow">${lastScan.hits.length} found · ${lastScan.durationMs} ms · ${interfaceLabel} · ${lastScan.advancedMatching ? "Softened" : "Exact"} matching${lastScan.stitchPreviewUrl ? ` · ${scanPasses} strips` : ""}</span><h2>${{ materials: "Materials", artefacts: "Artefacts", both: "Items" }[lastScan.mode]} found</h2></div></div>
      <div class="scan-results">
        ${lastScan.hits.map((hit) => hit.type === "artefact"
          ? `<div class="scan-hit">${img(artefactIcon(hit.artefact.id, hit.kind), "piece-icon")}<div><strong>${esc(hit.artefact.name)}</strong><span>${hit.kind}</span></div><b>${hit.quantity}</b></div>`
          : `<div class="scan-hit">${img(materialIcon(hit.material.id), "piece-icon")}<div><strong>${esc(hit.material.name)}</strong><span>material</span></div><b>${hit.quantity}</b></div>`,
        ).join("")}
  </div>
      ${renderStitchPreview(lastScan)}
      ${renderCapturedGrid(lastScan)}
      <div class="button-row">
        <button id="add-scan" class="gold-button" title="Save these amounts to your tracked list">Save to my list</button>
        <button id="discard-scan" class="secondary-button">Discard</button>
  </div>
      ${!lastScan.unresolved.length && lastScan.nearMisses.length ? `
        <details class="near-misses">
          <summary>Slots that were not matched (${lastScan.nearMisses.length})</summary>
          <p class="scan-hint">${lastScan.advancedMatching
            ? "Occupied slots that no sprite could claim, with the closest one shown. The first figure is how much of that sprite agreed with the slot; the second is how much of the slot it accounted for. A real match needs both to be high."
            : "Occupied slots skipped by exact sprite matching. Near-certain icons are still counted; the rest are listed for diagnosis only."}</p>
          ${lastScan.nearMisses.map((miss) => `
            <div class="miss-row"><span>${esc(miss.name)}</span><b>${miss.precision}% pixels · ${miss.recall}% of slot</b></div>`).join("")}
        </details>` : ""}
    </section>`;
};

const renderScan = (): string => {
  // Scan controls live on Overview; keep this tab for results/teach if opened.
  return `
    <main>
      ${renderScanResults() || `<section class="panel"><div class="empty">Use <strong>Scan</strong> on Overview to capture bank, workbench, or material storage.</div></section>`}
      <aside class="notice"><strong>Tip</strong><p>Matching uses in-game item sprites, so RuneScape should be at 100% interface scale. Results are always shown for review before anything is saved.</p></aside>
    </main>`;
};

/* -------------------------------------------------------------- settings */

const renderSettings = (): string => `
  <main>
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
      <label class="toggle-row">
        <input id="debug-scan-overlay" type="checkbox" ${state.debugScanOverlay ? "checked" : ""}>
        <span>Scan debug outlines <small>Green = detected · red = unresolved</small></span>
      </label>
      <label class="toggle-row">
        <input id="debug-stitch-preview" type="checkbox" ${state.debugStitchPreview ? "checked" : ""}>
        <span>Show stitched scan image <small>Debug · the PNG matched after Scan / Done</small></span>
      </label>
      <label class="toggle-row">
        <span>Outline thickness</span>
        <select id="debug-overlay-width" class="teach-select">
          ${[1, 2, 3].map((width) =>
            `<option value="${width}" ${state.debugOverlayWidth === width ? "selected" : ""}>${width} px</option>`,
          ).join("")}
        </select>
      </label>
      <label class="toggle-row">
        <input id="advanced-matching" type="checkbox" ${state.advancedMatching ? "checked" : ""}>
        <span>Softened icon matching <small>Off = exact only · on = near-exact soft (≥95%) can claim; weaker soft is teach/hint only</small></span>
      </label>
      <div class="setup-mode settings-mode">
        <span>Entry mode</span>
        <div class="mode-row">
          <button type="button" class="mode-chip ${state.entryMode === "auto" ? "active" : ""}" data-entry-mode="auto">
            <strong>Auto</strong>
            <small>Scan only · no +/−</small>
          </button>
          <button type="button" class="mode-chip ${state.entryMode === "manual" ? "active" : ""}" data-entry-mode="manual">
            <strong>Manual</strong>
            <small>Show +/− steppers</small>
          </button>
  </div>
  </div>
</section>
    <section class="panel">
      <div class="panel-heading"><div><h2>Local data</h2><p>Back up, restore, or wipe your tracked inventory.</p></div></div>
      <div class="button-row">
        <button id="export-data" class="secondary-button">Export JSON</button>
        <label class="file-button">Import JSON<input id="import-data" type="file" accept="application/json"></label>
        <button id="clear-inventory" class="danger-button">Clear saved list</button>
        <button id="reset-setup" class="secondary-button">Run setup again</button>
      </div>
      ${learnedCount() ? `<div class="button-row"><button id="forget-learned" class="secondary-button">Clear taught sprites (${learnedCount()})</button></div>
      <p class="scan-hint">Taught sprites are crops you confirmed from your own screen so scans recognise those icons next time. Clearing them returns matching to wiki art only.</p>` : ""}
      ${ignoredCount() ? `<div class="button-row"><button id="forget-ignored" class="secondary-button">Stop ignoring icons (${ignoredCount()})</button></div>
      <p class="scan-hint">Ignored icons are slots you marked as not being artefacts or materials, so scans skip them.</p>` : ""}
    </section>
    <section class="attribution">
      <p>Data and item icons from <a href="${archaeologyData.source}" target="_blank" rel="noreferrer">The RuneScape Wiki</a>. RuneScape is © Jagex Ltd. This third-party app is not endorsed by Jagex.</p>
    </section>
  </main>`;

/* ---------------------------------------------------------------- render */

const render = (): void => {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.density = state.compact ? "compact" : "roomy";

  if (!state.setupComplete) {
    app.innerHTML = `${renderHeader()}<div class="app-body">${renderSetup()}</div>`;
    return;
  }

  const content = {
    dashboard: renderDashboard, inventory: renderInventory,
    collections: renderCollections, scan: renderScan, settings: renderSettings,
  }[view]();

  app.innerHTML = `${renderHeader()}<div class="app-body">${content}</div>`;
  void ensureWatcherRunning();
  if (view === "dashboard") void ensureMaterialPrices();
  syncExcavationRateTimer();
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
  const label = document.querySelector<HTMLElement>(".scan-live-status");
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
  view = "dashboard";
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
    const { detected: located, crop } = await locateStitchCrop();
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
    setScanLiveStatus(`Capturing… ${stitch.strips} strip(s) — scroll, then Finish`);
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
      setScanLiveStatus(`Capturing… ${stitch.strips} strip(s) — scroll, then Finish`);

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
        setScanLiveStatus(`Capturing… ${stitch.strips} strip(s), +${status.appendedPx}px`);
      } else if (status.reason === "no-overlap") {
        joinWarnings += 1;
        setScanLiveStatus(`Capturing… ${stitch.strips} strip(s) — scroll back a bit (no overlap)`);
      } else {
        lastSig = settled;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Final strip at rest after Finish.
    appendSettledCrop(stitch);

    if (!stitch.composite || stitch.composite.height < 32) {
      showToast("Nothing captured — keep the storage open and try again.", "bad");
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
        debugOverlay: false,
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
        ? ` (${joinWarnings} strip(s) needed more overlap — check the preview)`
        : "";
    showToast(
      result.hits.length
        ? `Found ${result.hits.length} item type(s) from ${stitch.strips} strip(s).${warn}`
        : `Stitched ${stitch.strips} strip(s) but nothing matched.${warn}`,
      result.hits.length ? "good" : "bad",
    );
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The scan failed.", "bad");
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
  for (const hit of lastScan.hits) {
    if (hit.type === "artefact") {
      const current = getCount(state, hit.artefact.id)[hit.kind];
      setCount(state, hit.artefact.id, hit.kind, current + hit.quantity);
    } else {
      // Material storage / bank: only archaeology dig materials are tracked.
      if (!isArchaeologyMaterial(hit.material)) continue;
      setMaterial(state, hit.material.id, hit.quantity);
    }
  }
  state.lastScanAt = new Date().toISOString();
  saveStateNow(state);
  showToast(`Saved ${lastScan.hits.length} item type(s) to your list.`);
  lastScan = null;
  render();
};

const learnedKeyForHit = (hit: ScanHit): string =>
  hit.type === "artefact"
    ? artefactLearnedKey(hit.artefact.id, hit.kind)
    : materialLearnedKey(hit.material.id);

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
    showToast("Pick the item this icon is first.", "bad");
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
    lastScan.hits.sort((a, b) => {
      const nameA = a.type === "artefact" ? a.artefact.name : a.material.name;
      const nameB = b.type === "artefact" ? b.artefact.name : b.material.name;
      return nameA.localeCompare(nameB);
    });
  }

  // The slot is named now, so it is neither unresolved nor a near miss.
  const taughtCell = slot.cell;
  lastScan.unresolved.splice(index, 1);
  lastScan.nearMisses = lastScan.nearMisses.filter((miss) => miss.cell !== taughtCell);
  if (!lastScan.unresolved.length) lastScan.nearMisses = [];

  const label = hit
    ? hit.type === "artefact"
      ? `${hit.artefact.name} (${hit.kind})`
      : hit.material.name
    : "icon";
  showToast(`Learned ${label} — it will match on its own next scan.`);
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
    showToast(`Learned ${label} — it will match on the next scan.`);
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
      lastScan.hits.sort((a, b) => {
        const nameA = a.type === "artefact" ? a.artefact.name : a.material.name;
        const nameB = b.type === "artefact" ? b.artefact.name : b.material.name;
        return nameA.localeCompare(nameB);
      });
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
    showToast(`Learned ${label} from that slot.`);
    render();
    return;
  }

  // Drop unresolved rows whose guess already matches what we just taught.
  lastScan.unresolved = lastScan.unresolved.filter((slot) => slot.guessKey !== key);
  lastScan.nearMisses = lastScan.nearMisses.filter((miss) => {
    const still = lastScan!.unresolved.some((slot) => slot.cell === miss.cell);
    return still;
  });
  hoverTeachHint = `Learned ${label}. Hover another unmatched icon, or stop hover teach.`;
  showToast(`Learned ${label} from tooltip.`);
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
  const padX = Math.max(10, Math.round(lattice.cellWidth * 0.4));
  const padY = Math.max(10, Math.round(lattice.cellHeight * 0.4));
  const screenLeft = Math.round(origin.x + cx - lattice.cellWidth / 2) - padX;
  const screenTop = Math.round(origin.y + cy - offsetY - lattice.cellHeight / 2) - padY;
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
      screenWidth: Math.round(lattice.cellWidth) + padX * 2,
      screenHeight: Math.round(lattice.cellHeight) + padY * 2,
      cropDataUrl: cropUrl,
    },
  };
};

const startCellTeach = (row: number, column: number): void => {
  if (!lastScan) return;
  if (pendingTeachConfirm) {
    showToast("Confirm or cancel the pending name first.", "bad");
    return;
  }
  const mapped = cellScreenGate(lastScan, row, column);
  if (!mapped) {
    showToast("That cell has no icon crop to teach.", "bad");
    return;
  }

  if (!mapped.onScreen) {
    const place = storagePlaceLabel(lastScan.interfaceKind);
    showToast(
      `That icon isn’t in the current ${place} view. Scroll to it and scan again, or pick a cell that’s still on screen.`,
      "bad",
    );
    return;
  }

  stopHoverTeach();
  pendingTeachConfirm = null;
  cellTeach = { row, column };
  const place = storagePlaceLabel(lastScan.interfaceKind);
  hoverTeachHint = `Hover that ${place} slot until the tooltip appears.`;
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
          };
          cellTeach = null;
          hoverTeachHint = "";
          showToast(`Captured “${taught.label}” — confirm to learn it.`);
          render();
        },
        onStatus: updateTeachHud,
        onHud: updateTeachHud,
        onUntracked: (rawName) => {
          showToast(
            `“${rawName}” isn’t a tracked artefact or material.`,
            "bad",
          );
        },
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
      "bad",
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
    showToast("Pick an item name first.", "bad");
    return;
  }
  const parsed = parseLearnedKey(key);
  if (!parsed) {
    showToast("That name isn’t valid.", "bad");
    return;
  }
  const mapped = cellScreenGate(lastScan, cellTeach.row, cellTeach.column);
  if (!mapped) {
    showToast("That cell has no icon crop to teach.", "bad");
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
  };
  cellTeach = null;
  hoverTeachHint = "";
  showToast(`Selected “${label}” — confirm to learn it.`);
  render();
};

const ignoreCellTeach = (): void => {
  if (!lastScan || !cellTeach) return;
  const taught = cellTeach;
  const miss = lastScan.debugSlots.find(
    (slot) =>
      slot.row === taught.row &&
      slot.column === taught.column &&
      slot.kind === "miss",
  );
  if (!miss?.cropDataUrl) {
    showToast("That slot can’t be ignored.", "bad");
    return;
  }
  const unresolvedIndex = lastScan.unresolved.findIndex(
    (slot) => slot.dataUrl === miss.cropDataUrl,
  );
  stopHoverTeach();
  cellTeach = null;
  pendingTeachConfirm = null;
  hoverTeachHint = "";
  if (unresolvedIndex >= 0) {
    ignoreUnresolved(unresolvedIndex);
    return;
  }
  const signature = miss.key.startsWith("miss:") ? miss.key.slice(5) : miss.key;
  addIgnored(signature);
  lastScan.debugSlots = lastScan.debugSlots.filter(
    (slot) => !(slot.row === taught.row && slot.column === taught.column),
  );
  showToast("Ignored — that icon will not be listed again.");
  render();
};

const confirmPendingTeach = (): void => {
  const pending = pendingTeachConfirm;
  if (!pending) return;
  // learnFromHover reads pendingTeachConfirm for the cell coordinates.
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
  showToast("Ignored — that icon will not be listed again.");
  render();
};

const ensureWatcherRunning = async (): Promise<void> => {
  if (watcher?.running || watcherStarting) return;

  const status = getAlt1Status();
  if (!status.available) {
    return;
  }
  if (!status.pixelPermission || !status.linked) {
    return;
  }

  watcherStarting = true;
  try {
    void ensureMaterialPrices();
    if (!watcher) {
      const { ExcavationWatcher } = await import("./watcher");
      watcher = new ExcavationWatcher(
        (event) => {
          if (event.type === "artefact") {
            const current = getCount(state, event.artefact.id).damaged;
            setCount(state, event.artefact.id, "damaged", current + event.quantity);
            showToast(`Found ${event.artefact.name} (+${event.quantity} damaged).`);
          } else {
            const current = getMaterial(state, event.material.id);
            setMaterial(state, event.material.id, current + event.quantity);
            showToast(`Excavated ${event.material.name} (+${event.quantity}).`);
          }
          void recordWatcherFindValue(event).then(() => {
            syncExcavationRateTimer();
            refreshExcavationRateCard();
          });
          // setMaterial / setCount only persist; without a redraw the Inventory
          // tab keeps showing the previous counts.
          render();
        },
        () => {
          // Chat locate / permission messages — toast only on hard failures.
        },
      );
    }
    watcher.start();
  } catch (error) {
    watcher = null;
    showToast(
      error instanceof Error
        ? error.message
        : "Couldn’t start the excavation watcher.",
    );
  } finally {
    watcherStarting = false;
  }
};

/* ---------------------------------------------------------------- events */

const completeSetup = (): void => {
  state.setupComplete = true;
  saveStateNow(state);
  view = "dashboard";
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
    showToast("Enter your RuneScape display name first.", "bad");
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
    showToast(`Loaded level ${state.level} from ${result.source}.`);
    if (thenSetup) completeSetup();
    else render();
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    showToast(error instanceof Error ? error.message : "Could not load hiscores.", "bad");
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
    theme, kind, delta, favorite,
  } = button.dataset;

  if (favorite) {
    toggleFavorite(favorite);
    render();
  } else if (viewName) {
    if (viewName === "scan" || viewName === "artefacts" || viewName === "materials") {
      view = viewName === "scan" ? "dashboard" : "inventory";
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
  } else if (collapse) {
    if (collapsed.has(collapse)) collapsed.delete(collapse);
    else collapsed.add(collapse);
    if (collapse.startsWith("material:")) refresh("#material-list", renderMaterialRows);
    else refresh("#artefact-groups", renderArtefactGroups);
  } else if (filter) {
    collectionFilter = filter;
    render();
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
        : CULTURES.map((culture) => `culture:${culture}`);
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
  } else if (button.id === "hover-teach") {
    toggleHoverTeach();
  } else if (button.dataset.teachSave) {
    void learnUnresolved(Number(button.dataset.teachSave));
  } else if (button.dataset.teachIgnore) {
    ignoreUnresolved(Number(button.dataset.teachIgnore));
  } else if (button.id === "forget-ignored") {
    clearIgnored();
    showToast("Ignored icons cleared.");
    render();
  } else if (button.id === "forget-learned") {
    if (!confirmDestructive("forget-learned", "Clear every taught sprite?")) return;
    clearLearned();
    void import("./scanner").then(({ clearTargetCache }) => clearTargetCache());
    showToast("Taught sprites cleared.");
    render();
  } else if (button.id === "clear-inventory") {
    if (!confirmDestructive("clear-inventory", "Clear every saved artefact and material count?")) return;
    state.inventory = {};
    state.materials = {};
    saveStateNow(state);
    showToast("Saved list cleared.");
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
    showToast("Profile saved.");
    render();
  } else if (button.id === "reset-setup") {
    state.setupComplete = false;
    manualSetup = false;
    saveStateNow(state);
    render();
  } else if (button.id === "export-data") {
    exportState(state);
    showToast("Backup exported.");
  }
};

const handleChange = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;

  if (input.id === "debug-overlay-width") {
    state.debugOverlayWidth = Number(input.value);
    saveStateNow(state);
    return;
  }

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
  } else if (input.id === "compact-toggle") {
    state.compact = input.checked;
    saveStateNow(state);
    render();
  } else if (input.id === "debug-scan-overlay") {
    state.debugScanOverlay = input.checked;
    saveStateNow(state);
  } else if (input.id === "debug-stitch-preview") {
    state.debugStitchPreview = input.checked;
    saveStateNow(state);
    if (view === "dashboard" || view === "scan") render();
  } else if (input.id === "advanced-matching") {
    state.advancedMatching = input.checked;
    saveStateNow(state);
  } else if (input.id === "import-data") {
    const file = input.files?.[0];
    if (!file) return;
    try {
      state = await importState(file);
      showToast("Backup imported.");
      render();
    } catch {
      showToast("That file is not a valid companion backup.", "bad");
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
