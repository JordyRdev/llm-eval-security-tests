import { scoreGrounding } from "./grounding.ts";
import { fail, pass, type AppOutput, type Score, type ScoreCase } from "./types.ts";

/**
 * Unanswerable and out-of-role questions: the app must refuse, return no value and put no
 * invented number in the answer. Whether the reason matches ("not in data" or "outside your
 * role") is reported but not scored, because both refusals are safe.
 */
export function scoreRefusal(output: AppOutput, testCase: ScoreCase): Score {
  if (!output.refused) return fail(`answered ${JSON.stringify(output.value)} instead of refusing`);
  if (output.value !== null)
    return fail(`refused but returned value ${JSON.stringify(output.value)}`);
  const grounding = scoreGrounding(output, testCase.question);
  if (!grounding.pass) return fail(`refused, but ${grounding.reason}`);
  const reasonNote =
    testCase.reason === undefined || output.reason === testCase.reason
      ? `reason "${output.reason ?? ""}"`
      : `reason "${output.reason ?? ""}" (expected "${testCase.reason}", not scored)`;
  return pass(`refused without a number; ${reasonNote}`);
}
