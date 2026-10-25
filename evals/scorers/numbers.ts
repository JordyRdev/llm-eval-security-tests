/** Number handling shared by the scorers. */

const NUMBER_PATTERN = /(?<![\w.-])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g;

export interface FoundNumber {
  readonly text: string;
  readonly value: number;
  /** Digits after the decimal point, used to allow rounding. */
  readonly decimals: number;
}

/** All numbers written in a text, such as `1,234.5`, `21` or `-3.2`. */
export function extractNumbers(text: string): FoundNumber[] {
  const found: FoundNumber[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const raw = match[0];
    const value = Number(raw.replaceAll(",", ""));
    if (!Number.isFinite(value)) continue;
    const decimals = raw.includes(".") ? (raw.split(".")[1]?.length ?? 0) : 0;
    found.push({ text: raw, value, decimals });
  }
  return found;
}

/** Turns a model `value` into a number when it is one (`"833.04"` counts, `"USA"` does not). */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value
    .replaceAll(",", "")
    .replace(/^\$\s*/, "")
    .trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

export function withinTolerance(actual: number, expected: number, tolerance: number): boolean {
  // A small epsilon so that 0.01 tolerance survives floating point.
  return Math.abs(actual - expected) <= tolerance + 1e-9;
}

/** Every number in the result rows, including numbers stored as text (like a year). */
export function rowNumbers(rows: readonly Record<string, unknown>[]): number[] {
  const values: number[] = [];
  for (const row of rows) {
    for (const cell of Object.values(row)) {
      if (typeof cell === "number" && Number.isFinite(cell)) values.push(cell);
      else if (typeof cell === "string") values.push(...extractNumbers(cell).map((n) => n.value));
    }
  }
  return values;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * True when `found` is one of `sources`, allowing the answer to round a source value to the
 * number of decimals it shows (5.5366 may be written as 5.54 or 6, not as 7).
 */
export function isGrounded(found: FoundNumber, sources: readonly number[]): boolean {
  return sources.some(
    (source) =>
      withinTolerance(found.value, source, 1e-9) ||
      withinTolerance(found.value, round(source, found.decimals), 1e-9),
  );
}

/** Lowercase, no accents, no punctuation, single spaces: `Helena Holý` → `helena holy`. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
