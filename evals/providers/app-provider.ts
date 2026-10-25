/**
 * promptfoo provider that sends each question through the real pipeline (ChatEngine: input
 * guard, SQL, SQL guard, read-only query, answer, output guard).
 *
 * Environment: LLM_PROVIDER (groq | ollama | replay), APP_MODE, DB_DIR, REPLAY_FILE and
 * EVAL_RECORD=1 to save live replies to the replay file for later replay.
 *
 * Provider config (used by the security suite, which runs both modes in one eval):
 * `mode` overrides APP_MODE, `replayFile` overrides REPLAY_FILE and `includeMeta` adds the
 * number of model calls and the truncation flag to the output for the security checks.
 */
import { parseRole } from "../../src/auth/roles.ts";
import { ChatEngine } from "../../src/app/chat.ts";
import { parseAppMode, type AppMode } from "../../src/app/contract.ts";
import { DEFAULTS, type LlmProvider } from "../../src/llm/provider.ts";
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

export interface AppProviderConfig {
  readonly mode?: string;
  readonly replayFile?: string;
  readonly includeMeta?: boolean;
}

// One model client per replay file, shared by the hardened and vulnerable providers, so that
// a recording run writes all replies to the same file instead of overwriting each other.
const models = new Map<string, Promise<LlmProvider>>();

function sharedModel(replayFile: string): Promise<LlmProvider> {
  const record = isTrue(process.env["EVAL_RECORD"]);
  const key = [process.env["LLM_PROVIDER"] ?? "", String(record), replayFile].join("|");
  let model = models.get(key);
  if (!model) {
    model = createEvalProvider(process.env, replayFile, record);
    models.set(key, model);
  }
  return model;
}

export default class AppProvider {
  private engine: Promise<ChatEngine> | undefined;
  private readonly config: AppProviderConfig;
  private readonly mode: AppMode;

  constructor(options?: { readonly config?: AppProviderConfig }) {
    this.config = options?.config ?? {};
    this.mode = parseAppMode(this.config.mode ?? process.env["APP_MODE"]);
  }

  id(): string {
    return this.config.mode === undefined ? "ask-your-data" : `ask-your-data:${this.mode}`;
  }

  private getEngine(): Promise<ChatEngine> {
    const replayFile = this.config.replayFile ?? process.env["REPLAY_FILE"] ?? DEFAULTS.replayFile;
    this.engine ??= sharedModel(replayFile).then(
      (provider) => new ChatEngine({ provider, mode: this.mode }),
    );
    return this.engine;
  }

  async callApi(prompt: string, context?: CallContext): Promise<ProviderResponse> {
    try {
      const role = parseRole(context?.vars?.["role"]);
      const engine = await this.getEngine();
      const reply = await engine.ask(role, prompt);
      const { meta, ...publicPart } = reply;
      // Only the public contract goes to the scorers and the judge; latency and model differ
      // per run and would make replayed judge prompts unstable.
      const output = this.config.includeMeta
        ? {
            ...publicPart,
            meta: {
              mode: meta.mode,
              calls: meta.calls,
              truncated: meta.truncated,
              withheld: meta.withheld,
            },
          }
        : publicPart;
      return {
        output: JSON.stringify(output),
        metadata: { app: meta },
        tokenUsage: { total: meta.tokens, prompt: 0, completion: 0 },
        latencyMs: meta.latencyMs,
      };
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }
}
