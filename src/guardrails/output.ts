import { INVISIBLE } from "./invisible.ts";

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\((?:[a-z][a-z0-9+.-]*:|\/\/)[^)]*\)/gi;
const HTML_TAG = /<\/?[a-z][^<>]*>/gi;

/**
 * Cleans model text before it leaves the API (LLM10:2026 Improper Output Handling): removes
 * markdown images (a classic exfiltration channel) and HTML tags, turns links into plain text
 * and strips invisible characters. The UI also never renders answers as HTML.
 */
export function sanitizeOutput(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE, "")
    .replace(MARKDOWN_LINK, "$1")
    .replace(HTML_TAG, "")
    .replace(INVISIBLE, "")
    .trim();
}

/** Returns the canary strings that occur in `text` (case-insensitive). */
export function findCanaries(text: string, canaries: readonly string[]): string[] {
  const haystack = text.toLowerCase();
  return canaries.filter((canary) => canary !== "" && haystack.includes(canary.toLowerCase()));
}
