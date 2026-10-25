/**
 * promptfoo provider that sends each golden question through the real pipeline
 * (ChatEngine: input guard, SQL, SQL guard, read-only query, answer, output guard).
 *
 * Environment: LLM_PROVIDER (groq | ollama | replay), APP_MODE, DB_DIR, REPLAY_FILE and
 * EVAL_RECORD=1 to save live replies to REPLAY_FILE for later replay.
 */
import { parseRole } from "../../src/auth/roles.ts";
import { ChatEngine } from "../../src/app/chat.ts";
import { parseAppMode } from "../../src/app/contract.ts";
import { DEFAULTS } from "../../src/llm/provider.ts";
import { createEvalProvider, isTrue } from "./recording.ts";

interface CallContext {
  readonly vars?: Record<string, unknown>;
}

interface ProviderResponse {
  readonly output?: string;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
  readonly tokenUsage?: { total: number; prompt: number; completion: number };
  readonly latencyMs?: number;
}

export default class AppProvider {
  private engine: Promise<ChatEngine> | undefined;

  id(): string {
    return "ask-your-data";
  }

  private getEngine(): Promise<ChatEngine> {
    this.engine ??= createEvalProvider(
      process.env,
      process.env["REPLAY_FILE"] ?? DEFAULTS.replayFile,
      isTrue(process.env["EVAL_RECORD"]),
    ).then((provider) => new ChatEngine({ provider, mode: parseAppMode(process.env["APP_MODE"]) }));
    return this.engine;
  }

  async callApi(prompt: string, context?: CallContext): Promise<ProviderResponse> {
    try {
      const role = parseRole(context?.vars?.["role"]);
      const engine = await this.getEngine();
      const reply = await engine.ask(role, prompt);
      const { meta, ...publicPart } = reply;
      return {
        // Only the public contract goes to the scorers and the judge; meta (latency, model)
        // differs per run and would make replayed judge prompts unstable.
        output: JSON.stringify(publicPart),
        metadata: { app: meta },
        tokenUsage: { total: meta.tokens, prompt: 0, completion: 0 },
        latencyMs: meta.latencyMs,
      };
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }
}
