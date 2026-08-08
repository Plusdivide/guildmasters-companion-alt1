/**
 * Developer tools (watcher mode card, detection outlines, …).
 *
 * Public release: set `ENABLE_DEV_TOOLS` to false — see docs/PUBLISH.md.
 * When false, the Settings toggle and all gated UI are omitted entirely.
 */
export const ENABLE_DEV_TOOLS = false;

let sessionEnabled = false;

/** Sync from player preference after load / toggle. */
export const setDevModeEnabled = (on: boolean): void => {
  sessionEnabled = ENABLE_DEV_TOOLS && on;
};

/** True only when this build includes tools AND the Settings toggle is on. */
export const isDevToolsActive = (): boolean =>
  ENABLE_DEV_TOOLS && sessionEnabled;
