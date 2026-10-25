import { normalizeText, toNumber, withinTolerance } from "./numbers.ts";
import { fail, pass, type AppOutput, type Score, type ScoreCase } from "./types.ts";

function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Accuracy on `value`:
 * - numeric: within the absolute tolerance of the SQL-computed answer;
 * - categorical: the same name after normalising case, accents and punctuation (a value such as
 *   "Helena Holý (49.62)" also counts, as long as the expected name is in it as whole words).
 *   When `value` holds the winning metric instead of a name (such as `300.96` for "Rock"), the
 *   label is taken from the answer: the answer must name the expected label, a row in
 *   `rows_used` must hold exactly that label, and the answer must not also name the runner-up.
 *   A wrong name in `value` always fails;
 * - unanswerable and refusal: the app refused and returned no value.
 */
export function scoreAccuracy(output: AppOutput, testCase: ScoreCase): Score {
  const { expected } = testCase;
  switch (testCase.type) {
    case "numeric": {
      if (output.refused)
        return fail(`refused (${output.reason ?? "no reason"}) instead of answering`);
      const actual = toNumber(output.value);
      if (actual === null) return fail(`value ${JSON.stringify(output.value)} is not a number`);
      const target = Number(expected.value);
      const tolerance = expected.tolerance ?? 0;
      return withinTolerance(actual, target, tolerance)
        ? pass(`${String(actual)} is within ${String(tolerance)} of ${String(target)}`)
        : fail(
            `${String(actual)} differs from ${String(target)} by more than ${String(tolerance)}`,
          );
    }
    case "categorical": {
      if (output.refused)
        return fail(`refused (${output.reason ?? "no reason"}) instead of answering`);
      const target = normalizeText(String(expected.value));
      if (output.value !== null) {
        const actual = normalizeText(String(output.value));
        if (actual === target || containsPhrase(actual, target)) {
          return pass(`value matches ${String(expected.value)}`);
        }
        if (toNumber(output.value) === null) {
          return fail(`value ${JSON.stringify(output.value)} is not ${String(expected.value)}`);
        }
      }
      return scoreLabelInAnswer(output, testCase);
    }
    case "unanswerable":
    case "refusal": {
      if (!output.refused)
        return fail(`answered ${JSON.stringify(output.value)} instead of refusing`);
      if (output.value !== null)
        return fail(`refused but still returned value ${JSON.stringify(output.value)}`);
      return pass(`refused (${output.reason ?? "no reason"})`);
    }
  }
}

/**
 * True when a row holds exactly this label: one cell, or the text cells of the row together
 * (so FirstName and LastName columns form a name). "Rock And Roll" does not hold "Rock".
 */
function rowHolds(row: Record<string, unknown>, target: string): boolean {
  const cells = Object.values(row);
  const scalar = (cell: unknown): cell is string | number =>
    typeof cell === "string" || typeof cell === "number";
  if (cells.some((cell) => scalar(cell) && normalizeText(String(cell)) === target)) return true;
  const text = cells.filter((cell) => typeof cell === "string").join(" ");
  return normalizeText(text) === target;
}

/**
 * Categorical fallback for a numeric or missing `value`: the label must be named in the answer,
 * backed by `rows_used`, and the answer must not hedge by also naming the runner-up.
 */
function scoreLabelInAnswer(output: AppOutput, testCase: ScoreCase): Score {
  const label = String(testCase.expected.value);
  const target = normalizeText(label);
  const answer = normalizeText(output.answer);
  const shown = output.value === null ? "no value" : `value ${JSON.stringify(output.value)}`;
  if (target === "" || !containsPhrase(answer, target)) {
    return fail(`${shown} is not a name and the answer does not name ${label}`);
  }
  if (!output.rows_used.some((row) => rowHolds(row, target))) {
    return fail(`the answer names ${label}, but rows_used does not contain it`);
  }
  const runnerUp = testCase.expected.margin?.runner_up;
  if (runnerUp !== undefined) {
    const other = normalizeText(runnerUp);
    if (other !== "" && other !== target && containsPhrase(answer, other)) {
      return fail(`the answer names both ${label} and the runner-up ${runnerUp}`);
    }
  }
  return pass(`the answer names ${label} (${shown} is the winning metric)`);
}
