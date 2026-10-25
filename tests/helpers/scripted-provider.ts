import type { CompletionRequest, CompletionResult, LlmProvider } from "../../src/llm/provider.ts";

type Reply = string | ((request: CompletionRequest) => string) | Error;

/** Deterministic provider for unit tests: returns queued replies and records every request. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "replay" as const;
  readonly model = "scripted";
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly replies: Reply[]) {}

  complete(request: CompletionRequest): Promise<CompletionResult> {
    // Copy the messages: the engine keeps appending to the same array.
    this.requests.push({ ...request, messages: [...request.messages] });
    const reply = this.replies.shift();
    if (reply === undefined)
      return Promise.reject(new Error("ScriptedProvider ran out of replies"));
    if (reply instanceof Error) return Promise.reject(reply);
    const content = typeof reply === "function" ? reply(request) : reply;
    return Promise.resolve({
      content,
      model: this.model,
      provider: this.name,
      latencyMs: 0,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  }
}

export const sql = (query: string): string => JSON.stringify({ sql: query });

export const answer = (
  text: string,
  value: number | string | null,
  unit: string | null = null,
): string => JSON.stringify({ answer: text, value, unit, refused: false });
