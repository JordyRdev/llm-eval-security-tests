import { normalizeText, toNumber, withinTolerance } from "./numbers.ts";
import { fail, pass, type AppOutput, type Score, type ScoreCase } from "./types.ts";

function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Accuracy on `value`:
 * - numeric: within the absolute tolerance of the SQL-computed answer;
 * - categorical: the same name after normalising case, accents and punctuation (a value such as
 *   "Helena Holý (49.62)" also counts, as long as the expected name is in it as whole words);
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
      if (output.value === null) return fail("no value returned");
      const actual = normalizeText(String(output.value));
      const target = normalizeText(String(expected.value));
      return actual === target || containsPhrase(actual, target)
        ? pass(`value matches ${String(expected.value)}`)
        : fail(`value ${JSON.stringify(output.value)} is not ${String(expected.value)}`);
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
