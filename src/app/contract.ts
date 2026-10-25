import { z } from "zod";

/** Reply of the first model call: SQL, or a refusal. */
export const SqlStepSchema = z.union([
  z.object({ refused: z.literal(true), reason: z.string().min(1).max(200) }),
  z.object({ sql: z.string().min(1).max(4000), refused: z.literal(false).optional() }),
]);
export type SqlStep = z.infer<typeof SqlStepSchema>;

/** Reply of the second model call: the answer built from the rows. */
export const AnswerStepSchema = z.object({
  answer: z.string().min(1).max(2000),
  value: z.union([z.number(), z.string(), z.null()]),
  unit: z.string().max(40).nullable(),
  refused: z.boolean(),
  reason: z.string().max(200).optional(),
});
export type AnswerStep = z.infer<typeof AnswerStepSchema>;

/** Body of `POST /api/ask`. */
export const AskRequestSchema = z.object({
  role: z.string(),
  question: z.string().max(20_000),
});

/**
 * Public answer contract: `{ answer, value, unit, sql, rows_used, refused }`, plus the refusal
 * reason and run metadata. `sql` and `rows_used` come from the app, never from the model.
 */
export interface AskResponse {
  readonly answer: string;
  readonly value: number | string | null;
  readonly unit: string | null;
  readonly sql: string | null;
  readonly rows_used: Record<string, unknown>[];
  readonly refused: boolean;
  readonly reason?: string;
  readonly meta: {
    readonly role: string;
    readonly mode: AppMode;
    readonly provider: string;
    readonly model: string;
    readonly calls: number;
    readonly tokens: number;
    readonly latencyMs: number;
    readonly truncated: boolean;
    /** Result cells the hardened app withheld from the answer step as likely injection. */
    readonly withheld: number;
  };
}

export type AppMode = "hardened" | "vulnerable";

export function parseAppMode(value: string | undefined): AppMode {
  const mode = (value ?? "hardened").trim().toLowerCase();
  if (mode === "hardened" || mode === "vulnerable") return mode;
  throw new Error(`Unknown APP_MODE "${mode}". Use hardened or vulnerable.`);
}

/**
 * Pulls the first JSON object out of a model reply (models sometimes wrap it in a code fence
 * or add a sentence) and validates it.
 */
export function parseModelJson<T>(schema: z.ZodType<T>, content: string): T {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("reply contains no JSON object");
  return schema.parse(JSON.parse(content.slice(start, end + 1)));
}
