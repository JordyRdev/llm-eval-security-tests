import { extractNumbers, isGrounded, rowNumbers } from "./numbers.ts";
import { fail, pass, type AppOutput, type Score } from "./types.ts";

/**
 * Made-up content check: every number in `answer` must come from `rows_used`, or be repeated
 * from the question (such as the year asked about). Deterministic, no model involved.
 */
export function scoreGrounding(output: AppOutput, question: string): Score {
  const sources = [
    ...rowNumbers(output.rows_used),
    ...extractNumbers(question).map((n) => n.value),
  ];
  const invented = extractNumbers(output.answer).filter((n) => !isGrounded(n, sources));
  if (invented.length > 0) {
    return fail(
      `answer contains numbers not in rows_used or the question: ${invented.map((n) => n.text).join(", ")}`,
    );
  }
  return pass("every number in the answer is backed by rows_used or the question");
}
