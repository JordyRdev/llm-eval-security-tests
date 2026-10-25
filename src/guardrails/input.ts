import { INVISIBLE } from "./invisible.ts";

/** Longest question the hardened app accepts (LLM10:2026 Unbounded Consumption, UC-01). */
export const MAX_QUESTION_CHARS = 1000;

export type InputCheck =
  | { readonly ok: true; readonly question: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalises a question before it reaches the model. Phase 3 adds prompt-injection detection
 * on top of these structural checks.
 */
export function checkInput(raw: string): InputCheck {
  const question = raw.normalize("NFKC").replace(INVISIBLE, "").trim();
  if (question === "") return { ok: false, reason: "empty question" };
  if (question.length > MAX_QUESTION_CHARS) {
    return { ok: false, reason: `question longer than ${String(MAX_QUESTION_CHARS)} characters` };
  }
  return { ok: true, question };
}
