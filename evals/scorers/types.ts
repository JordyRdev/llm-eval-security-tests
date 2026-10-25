import type { Expected, QuestionType } from "../golden/golden.ts";

/** The public part of an app reply that the scorers look at. */
export interface AppOutput {
  readonly answer: string;
  readonly value: number | string | null;
  readonly unit: string | null;
  readonly sql: string | null;
  readonly rows_used: readonly Record<string, unknown>[];
  readonly refused: boolean;
  readonly reason?: string | undefined;
}

export interface ScoreCase {
  readonly type: QuestionType;
  readonly question: string;
  readonly expected: Expected;
  readonly reason?: string | undefined;
}

export interface Score {
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string;
}

export function pass(reason: string): Score {
  return { pass: true, score: 1, reason };
}

export function fail(reason: string): Score {
  return { pass: false, score: 0, reason };
}
