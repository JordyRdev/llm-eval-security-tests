import { RecordingProvider, ReplayProvider } from "../../src/llm/replay.ts";
import { createProvider, type LlmProvider, type ProviderEnv } from "../../src/llm/provider.ts";
import type { CompletionRequest, CompletionResult } from "../../src/llm/provider.ts";

/** Saves after every call, so an interrupted recording run keeps what it already has. */
class AutosaveRecorder implements LlmProvider {
  readonly name: LlmProvider["name"];
  readonly model: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly recorder: RecordingProvider) {
    this.name = recorder.name;
    this.model = recorder.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const result = await this.recorder.complete(request);
    this.queue = this.queue.then(() => this.recorder.save());
    await this.queue;
    return result;
  }
}

/**
 * Creates the provider for an eval run. With `record` set, every live reply is also written to
 * the replay file so the run can be replayed in CI without a model or a key.
 */
export async function createEvalProvider(
  env: ProviderEnv,
  replayFile: string,
  record: boolean,
): Promise<LlmProvider> {
  const provider = await createProvider({ ...env, REPLAY_FILE: replayFile });
  // A replay provider has nothing new to record; this lets you record only the judge.
  if (!record || provider instanceof ReplayProvider) return provider;
  return new AutosaveRecorder(new RecordingProvider(provider, replayFile));
}

export function isTrue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
