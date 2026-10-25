import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenBudget, type BudgetClock } from "../../src/llm/budget.ts";
import {
  OpenAICompatibleProvider,
  createProvider,
  resolveProviderName,
  stripThinking,
  type CompletionRequest,
  type OpenAICompatibleOptions,
} from "../../src/llm/provider.ts";
import {
  RecordingProvider,
  ReplayMissError,
  ReplayProvider,
  recordingKey,
} from "../../src/llm/replay.ts";

type Params = Record<string, unknown>;
type Step = { content: string } | { error: { status: number; headers?: Record<string, string> } };

function fakeClient(steps: Step[]): {
  client: NonNullable<OpenAICompatibleOptions["client"]>;
  calls: Params[];
} {
  const calls: Params[] = [];
  const create = (params: Params) => {
    calls.push(params);
    const step = steps.shift();
    if (!step) return Promise.reject(new Error("no more steps"));
    if ("error" in step) return Promise.reject(Object.assign(new Error("api error"), step.error));
    return Promise.resolve({
      model: "fake-model",
      choices: [{ message: { content: step.content } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
  };
  const client = { chat: { completions: { create } } } as unknown as NonNullable<
    OpenAICompatibleOptions["client"]
  >;
  return { client, calls };
}

function fakeClock(): BudgetClock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

const request: CompletionRequest = {
  messages: [
    { role: "system", content: "Reply with JSON." },
    { role: "user", content: "How many customers?" },
  ],
  maxTokens: 100,
  json: true,
};

function provider(steps: Step[], extra: Partial<OpenAICompatibleOptions> = {}) {
  const { client, calls } = fakeClient(steps);
  const clock = fakeClock();
  const instance = new OpenAICompatibleProvider({
    name: "groq",
    baseURL: "http://example.invalid/v1",
    apiKey: "test",
    model: "openai/gpt-oss-120b",
    client,
    clock,
    ...extra,
  });
  return { instance, calls, clock };
}

describe("OpenAICompatibleProvider", () => {
  it("sends deterministic, bounded, JSON-mode requests and reports usage", async () => {
    const { instance, calls } = provider([{ content: '{"sql":"SELECT 1"}' }], {
      reasoningEffort: "low",
    });
    const result = await instance.complete(request);
    expect(result).toMatchObject({
      content: '{"sql":"SELECT 1"}',
      model: "fake-model",
      provider: "groq",
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    });
    expect(calls[0]).toMatchObject({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      max_completion_tokens: 100,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
    });
  });

  it("omits JSON mode and reasoning effort when not requested", async () => {
    const { instance, calls } = provider([{ content: "hi" }]);
    await instance.complete({ messages: request.messages });
    expect(calls[0]).not.toHaveProperty("response_format");
    expect(calls[0]).not.toHaveProperty("reasoning_effort");
  });

  it("retries 429 using retry-after, and 5xx with exponential backoff", async () => {
    const { instance, calls, clock } = provider([
      { error: { status: 429, headers: { "retry-after": "3" } } },
      { error: { status: 503 } },
      { content: "ok" },
    ]);
    expect((await instance.complete(request)).content).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(clock.slept).toEqual([3000, 2000]);
  });

  it("does not retry client errors and gives up after maxRetries", async () => {
    const bad = provider([{ error: { status: 400 } }, { content: "never" }]);
    await expect(bad.instance.complete(request)).rejects.toMatchObject({ status: 400 });
    expect(bad.calls).toHaveLength(1);

    const flaky = provider(
      [{ error: { status: 500 } }, { error: { status: 500 } }, { content: "never" }],
      { maxRetries: 1 },
    );
    await expect(flaky.instance.complete(request)).rejects.toMatchObject({ status: 500 });
    expect(flaky.calls).toHaveLength(2);
  });

  it("runs one request at a time (concurrency 1)", async () => {
    let active = 0;
    let peak = 0;
    const create = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { model: "m", choices: [{ message: { content: "x" } }], usage: undefined };
    };
    const instance = new OpenAICompatibleProvider({
      name: "ollama",
      baseURL: "http://example.invalid/v1",
      apiKey: "x",
      model: "m",
      client: { chat: { completions: { create } } } as unknown as NonNullable<
        OpenAICompatibleOptions["client"]
      >,
    });
    await Promise.all([1, 2, 3].map(() => instance.complete(request)));
    expect(peak).toBe(1);
  });

  it("charges the budget with the real token usage", async () => {
    const budget = new TokenBudget({ tpd: 1000 }, fakeClock());
    const { instance } = provider([{ content: "a" }, { content: "b" }], { budget });
    await instance.complete(request);
    await instance.complete(request);
    expect(budget.usage().dayTokens).toBe(20);
  });

  it("strips <think> blocks from replies", async () => {
    const { instance } = provider([{ content: '<think>\nhmm\n</think>\n{"sql":"SELECT 1"}' }]);
    expect((await instance.complete(request)).content).toBe('{"sql":"SELECT 1"}');
    expect(stripThinking("<THINK>a</THINK> b <think>c</think>")).toBe("b");
  });
});

describe("provider selection", () => {
  it("prefers an explicit LLM_PROVIDER, then Groq with a key, then Ollama", () => {
    expect(resolveProviderName({ LLM_PROVIDER: "Replay" })).toBe("replay");
    expect(resolveProviderName({ GROQ_API_KEY: "gsk_x" })).toBe("groq");
    expect(resolveProviderName({ GROQ_API_KEY: "  " })).toBe("ollama");
    expect(resolveProviderName({})).toBe("ollama");
    expect(() => resolveProviderName({ LLM_PROVIDER: "openai" })).toThrow(/Unknown LLM_PROVIDER/);
  });

  it("creates providers without any secret except for Groq", async () => {
    const ollama = await createProvider({});
    expect([ollama.name, ollama.model]).toEqual(["ollama", "qwen3:4b"]);
    const groq = await createProvider({ GROQ_API_KEY: "gsk_test" });
    expect([groq.name, groq.model]).toEqual(["groq", "openai/gpt-oss-120b"]);
    await expect(createProvider({ LLM_PROVIDER: "groq" })).rejects.toThrow(/GROQ_API_KEY/);
    const replay = await createProvider({
      LLM_PROVIDER: "replay",
      REPLAY_FILE: "/nonexistent/recordings.json",
    });
    expect(replay.name).toBe("replay");
  });
});

describe("replay and recording", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("keys recordings on messages and JSON mode only", () => {
    expect(recordingKey(request)).toBe(recordingKey({ ...request, maxTokens: 5 }));
    expect(recordingKey(request)).not.toBe(recordingKey({ ...request, json: false }));
    expect(recordingKey(request)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("records replies and replays them without the network", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "replay-"));
    const file = path.join(dir, "nested", "app.json");
    const { instance } = provider([{ content: '{"sql":"SELECT 1"}' }]);
    const recorder = new RecordingProvider(instance, file);
    await recorder.complete(request);
    await recorder.save();
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")) as object)).toEqual([
      recordingKey(request),
    ]);

    const replay = await ReplayProvider.fromFile(file);
    expect(await replay.complete(request)).toMatchObject({
      content: '{"sql":"SELECT 1"}',
      provider: "replay",
      usage: { totalTokens: 10 },
    });
    await expect(replay.complete({ ...request, json: false })).rejects.toBeInstanceOf(
      ReplayMissError,
    );
  });
});
