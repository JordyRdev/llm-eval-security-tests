import OpenAI from "openai";
import {
  GROQ_FREE_LIMITS,
  TokenBudget,
  estimateTokens,
  systemClock,
  type BudgetClock,
} from "./budget.ts";

export type ProviderName = "groq" | "ollama" | "replay";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  /** Upper bound for the reply; also used for the budget estimate. */
  readonly maxTokens?: number;
  /** Ask for a JSON object (OpenAI `response_format: json_object`). */
  readonly json?: boolean;
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CompletionResult {
  readonly content: string;
  readonly usage: Usage;
  readonly model: string;
  readonly provider: ProviderName;
  readonly latencyMs: number;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export const DEFAULT_MAX_TOKENS = 600;

/** Removes `<think>...</think>` blocks that some open models put before their answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export interface OpenAICompatibleOptions {
  readonly name: Exclude<ProviderName, "replay">;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly budget?: TokenBudget;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  readonly maxRetries?: number;
  /**
   * Extra JSON-mode attempts after the API rejects its own output as invalid JSON (Groq's 400
   * `json_validate_failed`). Default 1.
   */
  readonly jsonRetries?: number;
  /**
   * After the JSON-mode attempts, try once more without JSON mode and keep the reply only if a
   * JSON object can be pulled out of it. Default true.
   */
  readonly plainJsonFallback?: boolean;
  readonly timeoutMs?: number;
  readonly clock?: BudgetClock;
  /** Injected for tests; defaults to a real OpenAI client. */
  readonly client?: Pick<OpenAI, "chat">;
}

interface RetryableError {
  status?: number;
  code?: string | null;
  message?: string;
  headers?: Headers | Record<string, string>;
}

/**
 * True for a 400 where the API itself failed to produce valid JSON in JSON mode (Groq returns
 * `code: "json_validate_failed"` with "Failed to generate JSON"). The request is fine; the
 * sampled output was not, so another attempt can succeed.
 */
export function isJsonGenerationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code, message } = error as RetryableError;
  if (status !== 400) return false;
  return code === "json_validate_failed" || /failed to generate json/i.test(message ?? "");
}

export class JsonGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonGenerationError";
  }
}

/**
 * Lenient JSON extraction for replies without JSON mode: drops a code fence or surrounding
 * text, and returns the outermost object only if it parses. Returns undefined otherwise.
 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  const candidate = text.slice(start, end + 1);
  try {
    const value: unknown = JSON.parse(candidate);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterMs(error: RetryableError): number | undefined {
  const headers = error.headers;
  const value = headers instanceof Headers ? headers.get("retry-after") : headers?.["retry-after"];
  const seconds = value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * One client for every OpenAI-compatible endpoint (Groq, Ollama's `/v1`). Calls run one at a
 * time, go through the token budget, and are retried with exponential backoff on 429 and 5xx.
 * A JSON-mode request that the API rejects as invalid JSON gets a bounded number of extra
 * attempts (see `jsonRetries` and `plainJsonFallback`); every attempt goes through the budget.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: OpenAICompatibleOptions["name"];
  readonly model: string;
  private readonly client: Pick<OpenAI, "chat">;
  private readonly clock: BudgetClock;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.model = options.model;
    this.clock = options.clock ?? systemClock;
    this.client =
      options.client ??
      new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey,
        maxRetries: 0,
        timeout: options.timeoutMs ?? 120_000,
      });
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    const result = this.queue.then(() => this.completeJsonSafe(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async completeJsonSafe(request: CompletionRequest): Promise<CompletionResult> {
    if (!request.json) return this.completeWithRetry(request);
    const jsonRetries = this.options.jsonRetries ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= jsonRetries; attempt++) {
      try {
        return await this.completeWithRetry(request);
      } catch (error) {
        if (!isJsonGenerationError(error)) throw error;
        lastError = error;
      }
    }
    if (this.options.plainJsonFallback === false) throw lastError;
    const result = await this.completeWithRetry({ ...request, json: false });
    const json = extractJsonObject(result.content);
    if (json === undefined) {
      throw new JsonGenerationError(
        `no valid JSON after ${String(jsonRetries + 1)} JSON-mode attempt(s) and one without JSON mode`,
        { cause: lastError },
      );
    }
    return { ...result, content: json };
  }

  private async completeWithRetry(request: CompletionRequest): Promise<CompletionResult> {
    const maxRetries = this.options.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.completeOnce(request);
      } catch (error) {
        const status = (error as RetryableError).status;
        const retryable = status === 429 || (status !== undefined && status >= 500);
        if (!retryable || attempt >= maxRetries) throw error;
        const backoff = retryAfterMs(error as RetryableError) ?? 1000 * 2 ** attempt;
        await this.clock.sleep(Math.min(backoff, 60_000));
      }
    }
  }

  private async completeOnce(request: CompletionRequest): Promise<CompletionResult> {
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const estimate = estimateTokens(request.messages.map((m) => m.content).join("\n")) + maxTokens;
    const reservation = await this.options.budget?.reserve(estimate);
    const started = performance.now();
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0,
      max_completion_tokens: maxTokens,
      ...(request.json ? { response_format: { type: "json_object" as const } } : {}),
      ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}),
    });
    const latencyMs = Math.round(performance.now() - started);
    const usage: Usage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? estimate,
    };
    reservation?.commit(usage.totalTokens);
    return {
      content: stripThinking(response.choices[0]?.message.content ?? ""),
      usage,
      model: response.model || this.model,
      provider: this.name,
      latencyMs,
    };
  }
}

export interface ProviderEnv {
  readonly LLM_PROVIDER?: string | undefined;
  readonly GROQ_API_KEY?: string | undefined;
  readonly GROQ_MODEL?: string | undefined;
  readonly GROQ_BASE_URL?: string | undefined;
  readonly OLLAMA_BASE_URL?: string | undefined;
  readonly OLLAMA_MODEL?: string | undefined;
  readonly REPLAY_FILE?: string | undefined;
}

export const DEFAULTS = {
  groqBaseURL: "https://api.groq.com/openai/v1",
  groqModel: "openai/gpt-oss-120b",
  ollamaBaseURL: "http://localhost:11434/v1",
  ollamaModel: "qwen3:4b",
  replayFile: "evals/recordings/app.json",
} as const;

/**
 * Picks the provider from the environment. Without `LLM_PROVIDER`, Groq is used when a key is
 * present and Ollama otherwise, so forks and local runs work without secrets.
 */
export function resolveProviderName(env: ProviderEnv): ProviderName {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "groq" || explicit === "ollama" || explicit === "replay") return explicit;
    throw new Error(`Unknown LLM_PROVIDER "${explicit}". Use groq, ollama or replay.`);
  }
  return env.GROQ_API_KEY?.trim() ? "groq" : "ollama";
}

export async function createProvider(env: ProviderEnv = process.env): Promise<LlmProvider> {
  const name = resolveProviderName(env);
  switch (name) {
    case "groq": {
      const apiKey = env.GROQ_API_KEY?.trim();
      if (!apiKey) throw new Error("LLM_PROVIDER=groq needs GROQ_API_KEY (see .env.example)");
      return new OpenAICompatibleProvider({
        name,
        baseURL: env.GROQ_BASE_URL ?? DEFAULTS.groqBaseURL,
        apiKey,
        model: env.GROQ_MODEL ?? DEFAULTS.groqModel,
        budget: new TokenBudget(GROQ_FREE_LIMITS),
        reasoningEffort: "low",
      });
    }
    case "ollama":
      return new OpenAICompatibleProvider({
        name,
        baseURL: env.OLLAMA_BASE_URL ?? DEFAULTS.ollamaBaseURL,
        apiKey: "ollama",
        model: env.OLLAMA_MODEL ?? DEFAULTS.ollamaModel,
        reasoningEffort: "none",
        maxRetries: 1,
      });
    case "replay": {
      const { ReplayProvider } = await import("./replay.ts");
      return ReplayProvider.fromFile(env.REPLAY_FILE ?? DEFAULTS.replayFile);
    }
  }
}
