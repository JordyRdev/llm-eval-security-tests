/**
 * Judge model for promptfoo's llm-rubric (faithfulness).
 *
 * JUDGE_PROVIDER: groq (default when GROQ_API_KEY is set), ollama, or replay. Replay answers
 * from recorded verdicts in JUDGE_REPLAY_FILE, so the judge also runs in forks without a key.
 * JUDGE_MODEL overrides the model; EVAL_RECORD=1 records live verdicts.
 */
import type { LlmProvider } from "../../src/llm/provider.ts";
import { createEvalProvider, isTrue } from "./recording.ts";

export const JUDGE_DEFAULTS = {
  groqModel: "qwen/qwen3.8-27b",
  // Another model family than the app model qwen3:4b, against self-preference.
  ollamaModel: "llama3.2:3b",
  replayFile: "evals/recordings/judge.json",
  maxTokens: 300,
} as const;

interface ProviderResponse {
  readonly output?: string;
  readonly error?: string;
  readonly tokenUsage?: { total: number; prompt: number; completion: number };
}

export default class JudgeProvider {
  private provider: Promise<LlmProvider> | undefined;

  id(): string {
    return "faithfulness-judge";
  }

  private getProvider(): Promise<LlmProvider> {
    const env = process.env;
    const model = env["JUDGE_MODEL"]?.trim();
    this.provider ??= createEvalProvider(
      {
        LLM_PROVIDER: env["JUDGE_PROVIDER"],
        GROQ_API_KEY: env["GROQ_API_KEY"],
        GROQ_MODEL: model || JUDGE_DEFAULTS.groqModel,
        OLLAMA_BASE_URL: env["OLLAMA_BASE_URL"],
        OLLAMA_MODEL: model || JUDGE_DEFAULTS.ollamaModel,
      },
      env["JUDGE_REPLAY_FILE"] ?? JUDGE_DEFAULTS.replayFile,
      isTrue(env["EVAL_RECORD"]),
    );
    return this.provider;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      const provider = await this.getProvider();
      const result = await provider.complete({
        messages: [{ role: "user", content: prompt }],
        json: true,
        maxTokens: JUDGE_DEFAULTS.maxTokens,
      });
      return {
        output: result.content,
        tokenUsage: {
          total: result.usage.totalTokens,
          prompt: result.usage.promptTokens,
          completion: result.usage.completionTokens,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }
}
