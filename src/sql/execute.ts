import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MAX_ROWS } from "./guard.ts";

export const QUERY_TIMEOUT_MS = 2000;

const CHILD = fileURLToPath(new URL("./query-child.ts", import.meta.url));

export type Row = Record<string, unknown>;

export interface QueryResult {
  readonly columns: string[];
  readonly rows: Row[];
  /** True when the query produced more than MAX_ROWS rows and the rest was cut off. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`query exceeded the ${String(timeoutMs)} ms timeout`);
    this.name = "QueryTimeoutError";
  }
}

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

type ChildMessage =
  | { ready: true }
  | { id: number; ok: true; columns: string[]; rows: unknown[][] }
  | { id: number; ok: false; error: string };

/**
 * Runs guarded SQL against one read-only database file in a child process. Queries run one
 * at a time; a query that exceeds the timeout gets its process killed and a fresh process is
 * started for the next query.
 */
export class QueryRunner {
  private child: ChildProcess | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    readonly timeoutMs: number = QUERY_TIMEOUT_MS,
  ) {}

  run(sql: string): Promise<QueryResult> {
    const result = this.queue.then(() => this.execute(sql));
    this.queue = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.child?.kill("SIGKILL");
    this.child = undefined;
    this.ready = undefined;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = fork(CHILD, [this.file], {
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (message: ChildMessage) => {
        if ("ready" in message) {
          child.off("exit", onExit);
          child.off("message", onMessage);
          resolve();
        }
      };
      const onExit = () => {
        this.child = undefined;
        this.ready = undefined;
        reject(new QueryError(`query process exited: ${stderr.trim()}`));
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
    });
    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
      }
    });
    return this.ready;
  }

  private async execute(sql: string): Promise<QueryResult> {
    await this.start();
    const child = this.child;
    if (!child) throw new QueryError("query process is not running");
    const id = this.nextId++;
    const started = performance.now();

    return new Promise<QueryResult>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        this.close();
        reject(new QueryTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
      const onExit = () => {
        cleanup();
        reject(new QueryError("query process exited unexpectedly"));
      };
      const onMessage = (message: ChildMessage) => {
        if ("ready" in message || message.id !== id) return;
        cleanup();
        if (!message.ok) {
          reject(new QueryError(message.error));
          return;
        }
        const truncated = message.rows.length > MAX_ROWS;
        const rows = message.rows
          .slice(0, MAX_ROWS)
          .map((values) => Object.fromEntries(message.columns.map((c, i) => [c, values[i]])));
        resolve({
          columns: message.columns,
          rows,
          truncated,
          durationMs: Math.round(performance.now() - started),
        });
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ id, sql });
    });
  }
}
