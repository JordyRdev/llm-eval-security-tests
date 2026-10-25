import { detectInjection } from "./injection.ts";
import { INVISIBLE } from "./invisible.ts";

/** Longest question the hardened app accepts (LLM10:2026 Unbounded Consumption, UC-01). */
export const MAX_QUESTION_CHARS = 1000;

export type InputCheck =
  | { readonly ok: true; readonly question: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalises a question before it reaches the model and rejects empty, oversized and likely
 * prompt-injection questions (see injection.ts).
 */
export function checkInput(raw: string): InputCheck {
  const question = raw.normalize("NFKC").replace(INVISIBLE, "").trim();
  if (question === "") return { ok: false, reason: "empty question" };
  if (question.length > MAX_QUESTION_CHARS) {
    return { ok: false, reason: `question longer than ${String(MAX_QUESTION_CHARS)} characters` };
  }
  const injection = detectInjection(question);
  if (injection !== null) return { ok: false, reason: `possible prompt injection (${injection})` };
  return { ok: true, question };
}
