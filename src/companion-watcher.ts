/**
 * Single screen watcher for dig finds + workbench restores.
 *
 * HARD CONTRACT (do not “helpfully” cross-wire these again):
 *
 *   idle ──(restore window)──► restore ──(window closes)──► idle
 *   idle ──(dig find)────────► excavate ──(60s no find/XP)──► idle
 *   excavate ──(XP rise)─────► excavate (timer refresh)
 *   excavate ──(restore title)► restore
 *
 * Idle alternates: dig probe ↔ restore probe ↔ dig ↔ restore…
 * Restore mode is restore-only until the window is gone, then idle.
 * Excavate mode: dig tick + cheap restore-title escape; XP listener on
 * to stay active between mat finds. XP listener is off in idle/restore.
 *
 * Why tweaking one breaks the other:
 * - One `busy` lock / one timer — a slow restore tick skips dig ticks.
 * - One mode — a false restore lock starves excavate (and vice versa).
 * - Shared Alt1 capture — hold-full dig fights plain restore captures.
 * - XP while excavating without a restore-title escape traps at workbench
 *   (restore Archaeology XP keeps refreshing the excavate timer).
 * Keep detectors independent; only the mode machine couples them.
 */
import {
  ExcavationWatcher,
  EXCAVATE_POLL_MS,
  type WatcherEvent,
} from "./watcher";
import {
  RestorationWatcher,
  RESTORE_ACTIVE_MS,
  RESTORE_IDLE_MS,
  type RestoreWatcherEvent,
  type RestoreWatcherStatus,
} from "./restore-watcher";

type CompanionMode = "idle" | "excavate" | "restore";

/** After this long with no dig find and no XP refresh, leave excavate mode. */
const EXCAVATE_MODE_IDLE_MS = 60_000;

/** Global callback name for alt1.xpRiseListener (must be on window). */
const XP_RISE_CALLBACK = "guildmasterCompanionXpRise";

declare global {
  interface Window {
    guildmasterCompanionXpRise?: (xp: number, skillId?: number) => void;
  }
}

export class CompanionWatcher {
  private timer: number | undefined;
  private busy = false;
  private pollMs = EXCAVATE_POLL_MS;
  private mode: CompanionMode = "idle";
  /** Idle: false = excavation probe, true = restoration probe. */
  private idlePreferRestore = false;
  /** Excavate: false = materials/chat, true = artefact popup. */
  private excavatePreferArtefact = false;
  private lastExcavateFindAt = 0;
  private xpListenerOn = false;
  private excavate: ExcavationWatcher;
  private restore: RestorationWatcher;

  constructor(
    onFind: (event: WatcherEvent) => void,
    onRestore: (event: RestoreWatcherEvent) => void,
    onRestoreStatus: (status: RestoreWatcherStatus) => void,
    onExcavateStatus: (message: string) => void = () => undefined,
  ) {
    this.excavate = new ExcavationWatcher((event) => {
      // Dig finds never steal restore mode — finish the workbench first.
      if (this.mode !== "restore") {
        this.enterExcavate();
      }
      onFind(event);
    }, onExcavateStatus);
    this.restore = new RestorationWatcher(onRestore, onRestoreStatus);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  get modeName(): CompanionMode {
    return this.mode;
  }

  getRestoreStatus(): RestoreWatcherStatus {
    return this.restore.getStatus();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.stopXpListener();
    this.mode = "idle";
    // First idle tick probes dig (artefacts/mats), then restore, then dig…
    this.idlePreferRestore = false;
    this.excavatePreferArtefact = false;
    this.lastExcavateFindAt = 0;
    this.excavate.prepare();
    this.restore.prepare();
    this.schedule(RESTORE_IDLE_MS);
    void this.tick();
  }

  /** Force back to idle alternating (e.g. after getting stuck). */
  resumeIdle(): void {
    this.stopXpListener();
    this.mode = "idle";
    this.idlePreferRestore = false;
    this.excavatePreferArtefact = false;
    this.lastExcavateFindAt = 0;
    this.restore.reset();
    this.restore.prepare();
    this.schedule(RESTORE_IDLE_MS);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.stopXpListener();
    this.mode = "idle";
    this.excavate.reset();
    this.restore.reset();
  }

  private schedule(ms: number): void {
    if (this.pollMs === ms && this.timer !== undefined) return;
    window.clearInterval(this.timer);
    this.pollMs = ms;
    this.timer = window.setInterval(() => void this.tick(), ms);
  }

  private excavateStillActive(now = Date.now()): boolean {
    return (
      this.lastExcavateFindAt > 0 &&
      now - this.lastExcavateFindAt < EXCAVATE_MODE_IDLE_MS
    );
  }

  private enterExcavate(): void {
    this.mode = "excavate";
    this.lastExcavateFindAt = Date.now();
    this.startXpListener();
  }

  /** Restore window closed → idle, dig next (don't immediately re-probe restore). */
  private enterIdleAfterRestore(): void {
    this.stopXpListener();
    this.mode = "idle";
    this.idlePreferRestore = false;
    this.excavatePreferArtefact = false;
    this.schedule(RESTORE_IDLE_MS);
  }

  /** Excavate went quiet → idle, restore probe next. */
  private enterIdleAfterExcavate(): void {
    this.stopXpListener();
    this.mode = "idle";
    this.idlePreferRestore = true;
    this.excavatePreferArtefact = false;
    this.schedule(RESTORE_IDLE_MS);
  }

  /** Workbench opened while digging — leave excavate before restore XP traps us. */
  private enterRestoreFromExcavate(): void {
    this.stopXpListener();
    this.mode = "restore";
    this.schedule(RESTORE_ACTIVE_MS);
  }

  private startXpListener(): void {
    if (this.xpListenerOn) return;
    const alt1 = window.alt1;
    if (!alt1?.xpRiseListener || !alt1.permissionGameState) return;

    window.guildmasterCompanionXpRise = () => {
      // Only refresh while excavating — listener should already be off otherwise.
      if (this.mode !== "excavate") return;
      this.lastExcavateFindAt = Date.now();
    };

    try {
      const ok = alt1.xpRiseListener(XP_RISE_CALLBACK);
      this.xpListenerOn = Boolean(ok);
      if (!this.xpListenerOn) {
        delete window.guildmasterCompanionXpRise;
      }
    } catch {
      this.xpListenerOn = false;
      delete window.guildmasterCompanionXpRise;
    }
  }

  private stopXpListener(): void {
    const alt1 = window.alt1;
    if (alt1?.xpRiseListener) {
      try {
        alt1.xpRiseListener("");
      } catch {
        // ignore — permission or API missing
      }
    }
    delete window.guildmasterCompanionXpRise;
    this.xpListenerOn = false;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // —— Restore-only until the window closes, then idle ——
      if (this.mode === "restore") {
        const restoring = await this.restore.tickOnce();
        if (restoring) {
          this.schedule(RESTORE_ACTIVE_MS);
          return;
        }
        this.enterIdleAfterRestore();
        return;
      }

      // —— Excavate: dig tick + cheap restore-title escape; XP keeps timer warm ——
      if (this.mode === "excavate") {
        if (!this.excavateStillActive()) {
          this.enterIdleAfterExcavate();
          // fall through to an idle probe this same tick
        } else {
          // Escape hatch: workbench open → restore (stop XP so restore XP
          // cannot keep refreshing the excavate timer).
          const restoring = await this.restore.probeIdle();
          if (restoring) {
            this.enterRestoreFromExcavate();
            return;
          }
          await this.excavate.tickDigOnce();
          this.schedule(EXCAVATE_POLL_MS);
          return;
        }
      }

      // —— Idle: restoration ↔ excavation ↔ … ——
      if (this.idlePreferRestore) {
        this.idlePreferRestore = false;
        // Cheap probe only — full restore tickOnce is for restore mode.
        const restoring = await this.restore.probeIdle();
        if (restoring) {
          this.stopXpListener();
          this.mode = "restore";
          this.schedule(RESTORE_ACTIVE_MS);
          return;
        }
      } else {
        this.idlePreferRestore = true;
        await this.excavate.tickDigOnce();
        if (this.excavateStillActive()) {
          this.enterExcavate();
          this.excavatePreferArtefact = false;
          this.schedule(EXCAVATE_POLL_MS);
          return;
        }
      }

      this.schedule(RESTORE_IDLE_MS);
    } finally {
      this.busy = false;
    }
  }
}
