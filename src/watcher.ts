import * as chatboxModule from "alt1/chatbox";
import { archaeologyData } from "./data";
import { matchArtefactText } from "./alt1";
import type { Artefact, MaterialInfo, TetraPieceId } from "./types";
import { TETRA_PIECE_IDS } from "./types";

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

export interface TetraPieceWatcherEvent {
  type: "tetracompass";
  piece: TetraPieceId;
  quantity: number;
  line: string;
}

export type WatcherEvent =
  | ArtefactWatcherEvent
  | MaterialWatcherEvent
  | TetraPieceWatcherEvent;

/** Poll cadence when CompanionWatcher is in excavate / idle mode. */
export const EXCAVATE_POLL_MS = 600;

/** Ignore chat finds whose [HH:MM:SS] is older than this (stops replaying history). */
const CHAT_MAX_AGE_SEC = 3;

// Chat messages that indicate a newly excavated item. Requiring an acquisition
// verb stops ordinary conversation containing an item name from changing counts.
// Wiki and live digs use "You find some Orthenglass." as well as excavate/receive.
// Auto-storage uses "You transport to your material storage: 1 x …".
const CHAT_FIND_PATTERN =
  /\b(?:you (?:find|excavate|discover|receive|uncover|get|transport)|you(?:'ve| have) (?:received|found|excavated)|added to your|transport(?:ed|s)? to your material storage|your .+ (?:transports?|sends?) )\b/i;

const normalized = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’']/g, "'")
    // OCR/chat may use either a hyphen or a space (Third-age / Third Age).
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Age of a chat line vs local clock using the leading [HH:MM:SS] stamp.
 * Returns null when there is no parseable timestamp.
 */
const chatMessageAgeSec = (text: string, now = Date.now()): number | null => {
  const msgSec = ChatBoxReader.getMessageTime(text);
  if (msgSec < 0) return null;
  const d = new Date(now);
  const nowSec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  let age = nowSec - msgSec;
  // Wrap at midnight.
  if (age < -12 * 3600) age += 24 * 3600;
  if (age < 0) age = 0;
  return age;
};

const isFreshChatLine = (text: string): boolean => {
  const age = chatMessageAgeSec(text);
  // No stamp → reject (first-read / OCR ghosts often lack a reliable time).
  if (age === null) return false;
  return age <= CHAT_MAX_AGE_SEC;
};

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

/**
 * Chat finds for dig tetracompass pieces, e.g.
 * "You find 1 x Tetracompass piece (needle)."
 * LotD may also echo "You receive: 1 x Tetracompass piece (needle)." for the
 * same piece — callers should dedupe those lines.
 */
export const matchTetracompassPieceText = (
  text: string,
): { piece: TetraPieceId; quantity: number } | null => {
  const line = normalized(text);
  if (!line.includes("tetracompass piece")) return null;
  const piece = TETRA_PIECE_IDS.find((id) =>
    new RegExp(`tetracompass piece\\s*\\(?\\s*${id}\\s*\\)?`).test(line),
  );
  if (!piece) return null;
  const amount =
    line.match(
      new RegExp(`\\b(\\d[\\d,]*)\\s*(?:x\\s*)?tetracompass piece`),
    )?.[1] ?? line.match(/\b(\d[\d,]*)\s*x\b/)?.[1];
  const quantity = amount ? Math.max(1, Number(amount.replace(/,/g, ""))) : 1;
  return { piece, quantity: Number.isFinite(quantity) ? quantity : 1 };
};

/**
 * Chat + artefact-dialogue excavation tracking.
 * CompanionWatcher drives ticks: dig passes use tickDigOnce (chat + popup).
 */
export class ExcavationWatcher {
  private reader = new ChatBoxReader();
  private located = false;
  // A dialogue remains on screen until dismissed. Remember it only while it is
  // visible, then allow the same artefact to be found again later.
  private activeDialogue: string | null = null;
  // If the same find is echoed to chat and shown in the dialogue a fraction
  // later, they are two reports of one item, not two items.
  private lastArtefact: { key: string; at: number } | null = null;
  // Dig "You find" + Luck of the Dwarves "You receive" name the same piece.
  private lastTetra: { piece: TetraPieceId; at: number } | null = null;
  private lastDialogueStatus = "";

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

  /** Prepare readers; CompanionWatcher owns the poll interval. */
  prepare(): void {
    this.onStatus("Looking for chat and artefact dialogues…");
    void import("./artefact-dialogue").then(({ warmArtefactDialogueFonts }) =>
      warmArtefactDialogueFonts(),
    );
  }

  reset(): void {
    this.located = false;
    this.activeDialogue = null;
    this.lastArtefact = null;
    this.lastTetra = null;
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

  private emitTetra(piece: TetraPieceId, quantity: number, line: string): void {
    const now = Date.now();
    // LotD shines + "You receive" is the same dig piece as "You find", not a second.
    if (
      this.lastTetra?.piece === piece &&
      now - this.lastTetra.at < 5000
    ) return;
    this.onFind({ type: "tetracompass", piece, quantity, line });
    this.lastTetra = { piece, at: now };
  }

  private ensureChatLocated(): void {
    if (this.located) return;
    if (!this.reader.find()) {
      this.onStatus("Chatbox not found; still watching for artefact dialogues.");
      return;
    }
    this.located = true;
    this.onStatus("Watching chat materials and artefact dialogues.");
  }

  private runChat(): void {
    this.ensureChatLocated();
    if (!this.located) return;

    const lines = this.reader.read();
    for (const line of lines ?? []) {
      const text = line.text?.trim();
      if (!text) continue;
      // Drop history / re-OCR of old lines (also kills first-read flood).
      if (!isFreshChatLine(text)) continue;

      const looksLikeFind =
        CHAT_FIND_PATTERN.test(text) ||
        /\(damaged\)/i.test(text) ||
        /you\s*find\s*:/i.test(text);
      if (!looksLikeFind) continue;

      const artefact = matchArtefactText(text, archaeologyData.artefacts);
      if (artefact) {
        const key = `artefact:${artefact.id}`;
        if (this.activeDialogue !== key) {
          this.emitArtefact(artefact, text);
          this.activeDialogue = key;
        }
        continue;
      }

      const tetra = matchTetracompassPieceText(text);
      if (tetra) {
        this.emitTetra(tetra.piece, tetra.quantity, text);
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

  private reportDialogueStatus(message: string): void {
    if (message === this.lastDialogueStatus) return;
    this.lastDialogueStatus = message;
    this.onStatus(message);
  }

  private async runDialogue(): Promise<void> {
    const { probeArtefactDialogue, warmArtefactDialogueFonts } = await import(
      "./artefact-dialogue"
    );
    await warmArtefactDialogueFonts();
    const probe = await probeArtefactDialogue();
    if (!probe.capture) {
      this.reportDialogueStatus("Artefact popup: screen capture failed.");
      this.activeDialogue = null;
      return;
    }
    if (!probe.hit) {
      this.activeDialogue = null;
      // Stay quiet unless OCR looked find-shaped — bare parchment (pylon
      // charge, other UI) is not a dig-popup near-miss.
      if (probe.paper && probe.findShaped) {
        const top = probe.topMatch
          ? `${probe.topMatch.id} @ ${probe.topMatch.score}`
          : "no template match";
        const second = probe.secondMatch
          ? ` (2nd ${probe.secondMatch.id} @ ${probe.secondMatch.score})`
          : "";
        const ocr = probe.readings[0]
          ? ` OCR:“${probe.readings[0].slice(0, 40)}”`
          : "";
        this.reportDialogueStatus(
          `Artefact popup: paper ok, ${top}${second}.${ocr}`,
        );
      }
      return;
    }
    const key = `artefact:${probe.hit.artefact.id}`;
    if (this.activeDialogue !== key) {
      this.emitArtefact(probe.hit.artefact, probe.hit.text);
      this.activeDialogue = key;
      this.reportDialogueStatus(`Artefact popup: ${probe.hit.artefact.name}`);
    }
  }

  /** Chat materials / artefact chat lines only (no popup OCR). */
  async tickChatOnce(): Promise<void> {
    try {
      this.runChat();
    } catch (error) {
      this.onStatus(
        `Watcher error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Artefact parchment popup only (no chat). */
  async tickDialogueOnce(): Promise<void> {
    try {
      await this.runDialogue();
    } catch (error) {
      this.onStatus(
        `Watcher error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Idle dig pass: chat then parchment find-dialogue. */
  async tickDigOnce(): Promise<void> {
    try {
      this.runChat();
      await this.runDialogue();
    } catch (error) {
      this.onStatus(
        `Watcher error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
