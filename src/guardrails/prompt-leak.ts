/**
 * Detects system-prompt leakage (LLM08:2026 Hidden Context Exposure): the prompt canary, or a
 * run of words copied from the static text of the app's prompts.
 */
export const SHINGLE_WORDS = 8;

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\{\{\w+\}\}/g, " ")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w !== "");
}

/** Every run of `size` consecutive words in the templates (placeholders removed). */
export function promptShingles(templates: readonly string[], size = SHINGLE_WORDS): Set<string> {
  const shingles = new Set<string>();
  for (const template of templates) {
    for (const line of template.split(/\n/)) {
      const w = words(line);
      for (let i = 0; i + size <= w.length; i++) shingles.add(w.slice(i, i + size).join(" "));
    }
  }
  return shingles;
}

export interface PromptFingerprint {
  readonly canary: string;
  readonly shingles: ReadonlySet<string>;
  readonly size?: number;
}

/** "prompt canary", "prompt text: <words>" or null. */
export function findPromptLeak(text: string, fingerprint: PromptFingerprint): string | null {
  if (fingerprint.canary !== "" && text.toLowerCase().includes(fingerprint.canary.toLowerCase())) {
    return "prompt canary";
  }
  const size = fingerprint.size ?? SHINGLE_WORDS;
  const w = words(text);
  for (let i = 0; i + size <= w.length; i++) {
    const shingle = w.slice(i, i + size).join(" ");
    if (fingerprint.shingles.has(shingle)) return `prompt text: "${shingle}"`;
  }
  return null;
}
