/**
 * Child process that runs one query at a time against a read-only SQLite file. It runs in its
 * own process so a slow query can be killed (SIGKILL) when it exceeds the timeout; a worker
 * thread cannot interrupt a synchronous native call. Runs on Node's built-in type stripping.
 */
import Database from "better-sqlite3";

interface QueryMessage {
  readonly id: number;
  readonly sql: string;
}

const file = process.argv[2];
if (!file) throw new Error("usage: query-child.ts <database file>");

const db = new Database(file, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");

process.on("message", (message: QueryMessage) => {
  try {
    const statement = db.prepare(message.sql);
    if (!statement.reader) throw new Error("statement does not return rows");
    const columns = statement.columns().map((c) => c.name);
    const rows = statement.raw(true).all() as unknown[][];
    process.send?.({ id: message.id, ok: true, columns, rows });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.send?.({ ready: true });
