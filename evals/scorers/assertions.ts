/**
 * Thin promptfoo wrappers around the pure scorers. promptfoo calls them as
 * `javascript` asserts with the provider output (a JSON string) and the test vars.
 */
import { scoreAccuracy } from "./accuracy.ts";
import { scoreGrounding } from "./grounding.ts";
import { scoreRefusal } from "./refusal.ts";
import type { AppOutput, Score, ScoreCase } from "./types.ts";

interface AssertContext {
  readonly vars: Record<string, unknown>;
}

function parseOutput(output: unknown): AppOutput | null {
  if (typeof output !== "string") return (output as AppOutput | null) ?? null;
  try {
    return JSON.parse(output) as AppOutput;
  } catch {
    return null;
  }
}

function caseFrom(context: AssertContext): ScoreCase {
  const raw = context.vars["case"];
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as ScoreCase;
}

function run(
  output: unknown,
  context: AssertContext,
  scorer: (out: AppOutput, testCase: ScoreCase) => Score,
): Score {
  const parsed = parseOutput(output);
  if (!parsed) return { pass: false, score: 0, reason: "output is not the app's JSON contract" };
  return scorer(parsed, caseFrom(context));
}

export function accuracy(output: unknown, context: AssertContext): Score {
  return run(output, context, scoreAccuracy);
}

export function grounding(output: unknown, context: AssertContext): Score {
  return run(output, context, (out, testCase) => scoreGrounding(out, testCase.question));
}

export function refusal(output: unknown, context: AssertContext): Score {
  return run(output, context, scoreRefusal);
}
