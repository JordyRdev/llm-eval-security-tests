import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CompletionRequest, CompletionResult, LlmProvider, Usage } from "./provider.ts";

/** One recorded model reply, keyed by a hash of the request messages. */
export interface Recording {
  readonly content: string;
  readonly model: string;
  readonly usage: Usage;
}

export type Recordings = Record<string, Recording>;

export class ReplayMissError extends Error {
  constructor(key: string) {
    super(
      `No recording for request ${key}. Record it first with a real provider (RecordingProvider).`,
    );
    this.name = "ReplayMissError";
  }
}

/** Stable key for a request: only the messages and JSON mode count, not the model. */
export function recordingKey(request: CompletionRequest): string {
  const payload = JSON.stringify({ messages: request.messages, json: request.json ?? false });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * Deterministic provider for CI and tests: answers from recordings, never calls the network.
 * A request without a recording fails instead of guessing.
 */
export class ReplayProvider implements LlmProvider {
  readonly name = "replay" as const;
  readonly model: string;

  constructor(
    private readonly recordings: Recordings,
    model = "replay",
  ) {
    this.model = model;
  }

  static async fromFile(file: string): Promise<ReplayProvider> {
    const text = await readFile(file, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
      throw error;
    });
    return new ReplayProvider(JSON.parse(text) as Recordings);
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    const key = recordingKey(request);
    const recording = this.recordings[key];
    if (!recording) return Promise.reject(new ReplayMissError(key));
    return Promise.resolve({ ...recording, provider: this.name, latencyMs: 0 });
  }
}

/** Wraps a real provider and stores every reply so it can be replayed later. */
export class RecordingProvider implements LlmProvider {
  readonly name: LlmProvider["name"];
  readonly model: string;
  private readonly recordings: Recordings = {};

  constructor(
    private readonly inner: LlmProvider,
    private readonly file: string,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const result = await this.inner.complete(request);
    this.recordings[recordingKey(request)] = {
      content: result.content,
      model: result.model,
      usage: result.usage,
    };
    return result;
  }

  async save(): Promise<void> {
    let existing: Recordings;
    try {
      existing = JSON.parse(await readFile(this.file, "utf8")) as Recordings;
    } catch {
      existing = {};
    }
    const merged = { ...existing, ...this.recordings };
    const sorted = Object.fromEntries(
      Object.keys(merged)
        .sort()
        .map((k) => [k, merged[k]]),
    );
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(sorted, null, 2)}\n`);
  }
}
