import * as chatboxModule from "alt1/chatbox";
import { archaeologyData } from "./data";
import { matchArtefactText } from "./alt1";
import type { Artefact, MaterialInfo } from "./types";

// alt1 ships webpack UMD bundles rather than ES modules, and bundlers disagree
// on how deep the class ends up: Vite's dev interop hands back the CommonJS
// exports object, so a plain default import is `{ defaultcolors, default }` and
// `new` on it throws. Unwrap until a constructor appears.
const ChatBoxReader = ((): typeof chatboxModule.default => {
  let value: unknown = chatboxModule;
  while (value && typeof value !== "function" && "default" in (value as object)) {
    value = (value as { default: unknown }).default;
  }
  if (typeof value !== "function") throw new Error("alt1 chatbox reader unavailable");
  return value as typeof chatboxModule.default;
})();

export interface ArtefactWatcherEvent {
  type: "artefact";
  artefact: Artefact;
  quantity: 1;
  line: string;
}

export interface MaterialWatcherEvent {
  type: "material";
  material: MaterialInfo;
  quantity: number;
  line: string;
}

export type WatcherEvent = ArtefactWatcherEvent | MaterialWatcherEvent;

// Chat messages that indicate a newly excavated item. Requiring an acquisition
// verb stops ordinary conversation containing an item name from changing counts.
// Wiki and live digs use "You find some Orthenglass." as well as excavate/receive.
const CHAT_FIND_PATTERN =
  /\b(?:you (?:find|excavate|discover|receive|uncover|get)|you(?:'ve| have) (?:received|found|excavated)|added to your|your .+ (?:transports?|sends?) )\b/i;

const normalized = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’']/g, "'")
    // OCR/chat may use either a hyphen or a space (Third-age / Third Age).
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const materialsByLongestName = [...archaeologyData.materials].sort(
  (a, b) => b.name.length - a.name.length,
);

export const matchMaterialText = (
  text: string,
): { material: MaterialInfo; quantity: number } | null => {
  const line = normalized(text);
  const material = materialsByLongestName.find((candidate) =>
    line.includes(normalized(candidate.name)),
  );
  if (!material) return null;

  // Handles "3 x material", "3 material", and defaults used by messages such as
  // "You excavate some third-age iron."
  const name = normalized(material.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const amount =
    line.match(new RegExp(`\\b(\\d[\\d,]*)\\s*(?:x\\s*)?${name}\\b`))?.[1] ??
    line.match(/\b(\d[\d,]*)\s*x\b/)?.[1];
  const quantity = amount ? Math.max(1, Number(amount.replace(/,/g, ""))) : 1;
  return { material, quantity: Number.isFinite(quantity) ? quantity : 1 };
};

export class ExcavationWatcher {
  private reader = new ChatBoxReader();
  private timer: number | undefined;
  private located = false;
  private busy = false;
  // A dialogue remains on screen until dismissed. Remember it only while it is
  // visible, then allow the same artefact to be found again later.
  private activeDialogue: string | null = null;
  // If the same find is echoed to chat and shown in the dialogue a fraction
  // later, they are two reports of one item, not two items.
  private lastArtefact: { key: string; at: number } | null = null;

  private onFind: (event: WatcherEvent) => void;
  private onStatus: (message: string) => void;

  constructor(
    onFind: (event: WatcherEvent) => void,
    onStatus: (message: string) => void,
  ) {
    this.onFind = onFind;
    this.onStatus = onStatus;
    // Let Alt1's chat reader track overlap/timestamps and return only new lines.
    // Deduplicating by text was wrong: two legitimate "You excavate some…"
    // messages are identical and the old watcher counted only the first one.
    this.reader.diffRead = true;
    this.reader.diffReadUseTimestamps = true;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setInterval(() => void this.tick(), 600);
    // Announce before the first pass so a failure reported from it survives.
    this.onStatus("Looking for chat and artefact dialogues…");
    void this.tick();
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.located = false;
    this.activeDialogue = null;
    this.lastArtefact = null;
    this.onStatus("Watcher stopped.");
  }

  private emitArtefact(artefact: Artefact, line: string): void {
    const key = `artefact:${artefact.id}`;
    const now = Date.now();
    if (
      this.lastArtefact?.key === key &&
      now - this.lastArtefact.at < 5000
    ) return;
    this.onFind({ type: "artefact", artefact, quantity: 1, line });
    this.lastArtefact = { key, at: now };
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.located) {
        if (!this.reader.find()) {
          this.onStatus("Chatbox not found; still watching for artefact dialogues.");
        } else {
          this.located = true;
          this.onStatus("Watching chat materials and artefact dialogues.");
        }
      }

      if (this.located) {
        const lines = this.reader.read();
        for (const line of lines ?? []) {
          const text = line.text?.trim();
          if (!text || !CHAT_FIND_PATTERN.test(text)) continue;

          // Some clients/settings also echo the damaged artefact to chat. Prefer
          // that exact text if present; the active-dialogue key prevents the same
          // find being added again when the popup is read below.
          const artefact = matchArtefactText(text, archaeologyData.artefacts);
          if (artefact) {
            const key = `artefact:${artefact.id}`;
            if (this.activeDialogue !== key) {
              this.emitArtefact(artefact, text);
              this.activeDialogue = key;
            }
            continue;
          }

          const material = matchMaterialText(text);
          if (material) {
            this.onFind({
              type: "material",
              material: material.material,
              quantity: material.quantity,
              line: text,
            });
          }
        }
      }

      // Kept as a lazy import because the dialog OCR font/capture code is only
      // needed while the watcher is running.
      const { readArtefactDialogue } = await import("./artefact-dialogue");
      const dialogue = readArtefactDialogue();
      if (!dialogue) {
        this.activeDialogue = null;
      } else {
        const key = `artefact:${dialogue.artefact.id}`;
        if (this.activeDialogue !== key) {
          this.emitArtefact(dialogue.artefact, dialogue.text);
          this.activeDialogue = key;
        }
      }
    } catch (error) {
      // Losing the chatbox mid-session is normal (the interface can be closed),
      // so re-find it next tick. Anything else is worth showing rather than
      // leaving the watcher looking alive while it silently does nothing.
      // Do not clear `located` on every error — dialogue OCR failures were wiping
      // a working chat reader and stopping materials from being counted.
      this.onStatus(
        `Watcher error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }
}
