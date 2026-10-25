import { readFileSync } from "node:fs";
import { ROLE_DEFINITIONS, type Role } from "../auth/roles.ts";
import { roleDbPath, vulnerableDbPath, DEFAULT_BUILD_DIR } from "../db/paths.ts";
import { checkInput } from "../guardrails/input.ts";
import { sanitizeOutput } from "../guardrails/output.ts";
import type { ChatMessage, LlmProvider } from "../llm/provider.ts";
import { QueryRunner, type QueryResult } from "../sql/execute.ts";
import { guardSql } from "../sql/guard.ts";
import { describeSchema, listTables } from "../sql/schema.ts";
import {
  AnswerStepSchema,
  SqlStepSchema,
  parseModelJson,
  type AnswerStep,
  type AppMode,
  type AskResponse,
} from "./contract.ts";

/** A question never costs more than this many model calls (UC-04). */
export const MAX_LLM_CALLS = 3;
/** Rows sent to the answer step and returned as `rows_used`. */
export const MAX_ROWS_FOR_ANSWER = 50;
const MAX_CELL_CHARS = 300;

const SYSTEM_TEMPLATE = readFileSync(new URL("./prompts/system.md", import.meta.url), "utf8");
const ANSWER_TEMPLATE = readFileSync(new URL("./prompts/answer.md", import.meta.url), "utf8");

export interface ChatEngineOptions {
  readonly provider: LlmProvider;
  readonly mode?: AppMode;
  readonly dbDir?: string;
  readonly queryTimeoutMs?: number;
}

interface Target {
  readonly runner: QueryRunner;
  readonly tables: string[];
  readonly schema: string;
}

interface RunState {
  calls: number;
  tokens: number;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

function roleContext(role: Role, mode: AppMode): string {
  const def = ROLE_DEFINITIONS[role];
  if (mode === "vulnerable") {
    // Deliberately weak: one database with everything, the role boundary lives only here.
    return def.employeeId === undefined
      ? `You are helping the sales manager. Do not reveal customer emails, phones, addresses or the employee_comp table.`
      : `You are helping ${def.displayName}, sales support agent with EmployeeId ${String(def.employeeId)}. The database contains all customers. Only answer about customers where Customer.SupportRepId = ${String(def.employeeId)}; "my customers" means those. Never show other agents' customers or the employee_comp table.`;
  }
  return def.employeeId === undefined
    ? "You are helping the sales manager. The database contains all customers of all agents; customer contact details are masked."
    : `You are helping ${def.displayName}, a sales support agent. The database contains only ${def.displayName.split(" ")[0] ?? ""}'s own customers, so "my customers", "my revenue" and "my invoices" mean all rows in it. Data about other agents is not available.`;
}

function trimRows(result: QueryResult): Record<string, unknown>[] {
  return result.rows
    .slice(0, MAX_ROWS_FOR_ANSWER)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          typeof v === "string" && v.length > MAX_CELL_CHARS ? `${v.slice(0, MAX_CELL_CHARS)}…` : v,
        ]),
      ),
    );
}

/**
 * The text-to-SQL pipeline: input guard → model writes SQL → SQL guard → read-only query on
 * the role's own database → model phrases the answer from the rows → output guard.
 */
export class ChatEngine {
  readonly mode: AppMode;
  private readonly provider: LlmProvider;
  private readonly dbDir: string;
  private readonly queryTimeoutMs: number | undefined;
  private readonly targets = new Map<string, Target>();

  constructor(options: ChatEngineOptions) {
    this.provider = options.provider;
    this.mode = options.mode ?? "hardened";
    this.dbDir = options.dbDir ?? DEFAULT_BUILD_DIR;
    this.queryTimeoutMs = options.queryTimeoutMs;
  }

  close(): void {
    for (const target of this.targets.values()) target.runner.close();
    this.targets.clear();
  }

  private target(role: Role): Target {
    const file =
      this.mode === "vulnerable" ? vulnerableDbPath(this.dbDir) : roleDbPath(role, this.dbDir);
    let target = this.targets.get(file);
    if (!target) {
      target = {
        runner: new QueryRunner(file, this.queryTimeoutMs),
        tables: listTables(file),
        schema: describeSchema(file),
      };
      this.targets.set(file, target);
    }
    return target;
  }

  async ask(role: Role, rawQuestion: string): Promise<AskResponse> {
    const started = performance.now();
    const state: RunState = { calls: 0, tokens: 0 };
    let truncated = false;

    const respond = (
      body: Omit<AskResponse, "meta" | "answer"> & { answer: string },
    ): AskResponse => ({
      ...body,
      answer: this.mode === "hardened" ? sanitizeOutput(body.answer) : body.answer,
      meta: {
        role,
        mode: this.mode,
        provider: this.provider.name,
        model: this.provider.model,
        calls: state.calls,
        tokens: state.tokens,
        latencyMs: Math.round(performance.now() - started),
        truncated,
      },
    });
    const refuse = (reason: string, sql: string | null = null): AskResponse =>
      respond({
        answer: refusalText(reason),
        value: null,
        unit: null,
        sql,
        rows_used: [],
        refused: true,
        reason,
      });

    let question = rawQuestion;
    if (this.mode === "hardened") {
      const input = checkInput(rawQuestion);
      if (!input.ok) return refuse(`input rejected: ${input.reason}`);
      question = input.question;
    }

    const target = this.target(role);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: fill(SYSTEM_TEMPLATE, {
          role_context: roleContext(role, this.mode),
          schema: target.schema,
        }),
      },
      { role: "user", content: `Question: ${question}` },
    ];

    // Step 1: SQL, with one retry that feeds the problem back to the model.
    let sql: string | null = null;
    let result: QueryResult | null = null;
    while (state.calls < MAX_LLM_CALLS - 1 && result === null) {
      const reply = await this.call(state, messages, 400);
      messages.push({ role: "assistant", content: reply });
      let problem: string;
      try {
        const step = parseModelJson(SqlStepSchema, reply);
        if ("reason" in step) return refuse(normaliseReason(step.reason));
        sql = step.sql;
        const guard = guardSql(step.sql, { allowedTables: target.tables });
        if (!guard.ok) {
          problem = `The SQL was rejected: ${guard.reason}.`;
        } else {
          try {
            result = await target.runner.run(guard.sql);
            truncated = result.truncated;
            break;
          } catch (error) {
            problem = `The SQL failed: ${error instanceof Error ? error.message : String(error)}.`;
          }
        }
      } catch {
        problem = "The reply was not the required JSON object.";
      }
      messages.push({
        role: "user",
        content: `${problem} Reply again with one JSON object as instructed.`,
      });
    }
    if (result === null) return refuse("could not answer safely", sql);

    // Step 2: answer from the rows only. No rows (or only NULLs) means the data does not have
    // it; that is decided here, without asking the model.
    const rows = trimRows(result);
    if (rows.every((row) => Object.values(row).every((v) => v === null))) {
      return refuse("not in data", sql);
    }
    const answerMessages: ChatMessage[] = [
      {
        role: "system",
        content: fill(ANSWER_TEMPLATE, { role_name: ROLE_DEFINITIONS[role].displayName }),
      },
      {
        role: "user",
        content: [
          `Question: ${question}`,
          `SQL: ${sql ?? ""}`,
          `Rows (${String(result.rows.length)}${result.truncated ? "+, truncated" : ""}): ${JSON.stringify(rows)}`,
          "",
          'Now reply with the answer object {"answer", "value", "unit", "refused"}.',
        ].join("\n"),
      },
    ];
    let answer: AnswerStep | null = null;
    while (state.calls < MAX_LLM_CALLS && answer === null) {
      const reply = await this.call(state, answerMessages, 300);
      try {
        answer = parseModelJson(AnswerStepSchema, reply);
      } catch {
        answerMessages.push(
          { role: "assistant", content: reply },
          { role: "user", content: "That was not the required JSON object. Reply again." },
        );
      }
    }
    if (answer === null) return refuse("could not answer safely", sql);

    return respond({
      answer: answer.answer,
      value: answer.refused ? null : answer.value,
      unit: answer.refused ? null : answer.unit,
      sql,
      rows_used: rows,
      refused: answer.refused,
      ...(answer.refused ? { reason: normaliseReason(answer.reason ?? "not in data") } : {}),
    });
  }

  private async call(state: RunState, messages: ChatMessage[], maxTokens: number): Promise<string> {
    if (state.calls >= MAX_LLM_CALLS) throw new Error("LLM call budget exhausted");
    state.calls++;
    const result = await this.provider.complete({ messages, maxTokens, json: true });
    state.tokens += result.usage.totalTokens;
    return result.content;
  }
}

function normaliseReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("role")) return "outside your role";
  if (lower.includes("not in data") || lower.includes("data")) return "not in data";
  return lower.slice(0, 100);
}

function refusalText(reason: string): string {
  switch (reason) {
    case "not in data":
      return "I can't answer that from the data.";
    case "outside your role":
      return "That is outside your role, so I can't show it.";
    default:
      return `I can't answer that (${reason}).`;
  }
}
