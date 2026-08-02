// Icons the user has marked as "not an artefact or material". The bank is full of
// items this app does not track, and nothing in the picture says whether a small
// brown blob is a soil stack or a small brown artefact — so the user gets to say
// once, and the scanner remembers.
//
// A signature is a coarse 8x8 grayscale of the slot with the stack-count rows left
// out, so the same item stops being reported even when its stack size changes.

const STORAGE_KEY = "rs3-archaeology-companion:ignored:v1";

// Sum of per-cell brightness differences (each cell is 0-15) that still counts as
// the same icon. Generous enough for anti-aliasing and the slot's hover highlight.
const MAX_DISTANCE = 40;

export const loadIgnored = (): string[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? (JSON.parse(stored) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

export const addIgnored = (signature: string): void => {
  const signatures = loadIgnored();
  if (signatures.includes(signature)) return;
  signatures.push(signature);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(signatures));
};

export const clearIgnored = (): void => {
  localStorage.removeItem(STORAGE_KEY);
};

export const ignoredCount = (): number => loadIgnored().length;

const distance = (a: string, b: string): number => {
  if (a.length !== b.length) return Infinity;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += Math.abs(parseInt(a[index], 16) - parseInt(b[index], 16));
  }
  return total;
};

export const isIgnored = (signature: string, signatures: string[]): boolean =>
  signatures.some((other) => distance(signature, other) <= MAX_DISTANCE);
