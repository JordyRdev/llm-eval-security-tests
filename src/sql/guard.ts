import nodeSqlParser from "node-sql-parser";

const { Parser } = nodeSqlParser;
const parser = new Parser();
const DIALECT = { database: "sqlite" } as const;

/** Maximum number of rows returned to the model and the user. */
export const MAX_ROWS = 200;
export const MAX_SQL_LENGTH = 4000;

/**
 * Functions the model may call. Anything else (e.g. `load_extension`, `readfile`,
 * `pragma_table_info`, `randomblob`) is rejected.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "abs",
  "avg",
  "cast",
  "coalesce",
  "count",
  "date",
  "datetime",
  "group_concat",
  "ifnull",
  "iif",
  "instr",
  "julianday",
  "length",
  "lower",
  "ltrim",
  "max",
  "min",
  "nullif",
  "printf",
  "replace",
  "round",
  "rtrim",
  "strftime",
  "substr",
  "substring",
  "sum",
  "time",
  "total",
  "trim",
  "upper",
  "dense_rank",
  "rank",
  "row_number",
]);

/** Defence in depth on the raw text, before parsing. */
const FORBIDDEN_KEYWORDS =
  /\b(pragma\w*|attach|detach|vacuum|reindex|analyze|load_extension|readfile|writefile|sqlite_\w+|fts3_tokenizer)\b/i;

export type GuardResult =
  | { readonly ok: true; readonly sql: string; readonly tables: string[] }
  | { readonly ok: false; readonly reason: string };

export interface GuardOptions {
  /** Tables the query may read; compared case-insensitively. */
  readonly allowedTables: readonly string[];
}

function reject(reason: string): GuardResult {
  return { ok: false, reason };
}

/** Collects every function name in a node-sql-parser AST. */
function collectFunctions(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFunctions(item, found);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const type = record["type"];
  if (type === "aggr_func" && typeof record["name"] === "string") {
    found.add(record["name"].toLowerCase());
  } else if (type === "function") {
    found.add(functionName(record["name"]));
  } else if (type === "cast") {
    found.add("cast");
  }
  for (const value of Object.values(record)) collectFunctions(value, found);
}

function functionName(name: unknown): string {
  if (typeof name === "string") return name.toLowerCase();
  if (name && typeof name === "object" && "name" in name && Array.isArray(name.name)) {
    return (name.name as { value?: unknown }[])
      .map((part) => (typeof part.value === "string" ? part.value : ""))
      .join(".")
      .toLowerCase();
  }
  return "<unknown>";
}

/** Collects CTE names so `WITH t AS (...) SELECT ... FROM t` is not mistaken for a real table. */
function collectCteNames(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCteNames(item, found);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record["with"])) {
    for (const cte of record["with"] as { name?: { value?: unknown } }[]) {
      if (typeof cte.name?.value === "string") found.add(cte.name.value.toLowerCase());
    }
  }
  for (const value of Object.values(record)) collectCteNames(value, found);
}

/**
 * Accepts exactly one read-only SELECT (optionally with CTEs) over allowed tables and allowed
 * functions, and wraps it so at most MAX_ROWS + 1 rows come back (the extra row signals
 * truncation). Fails closed: anything the parser cannot read is rejected.
 */
export function guardSql(input: string, options: GuardOptions): GuardResult {
  const sql = input.trim().replace(/;\s*$/, "").trim();
  if (sql === "") return reject("empty query");
  if (sql.length > MAX_SQL_LENGTH) return reject("query too long");
  if (sql.includes(";")) return reject("multiple statements are not allowed");
  const keyword = FORBIDDEN_KEYWORDS.exec(sql);
  if (keyword) return reject(`forbidden keyword: ${keyword[1] ?? ""}`);

  let statements: unknown[];
  let tableList: string[];
  try {
    const ast = parser.astify(sql, DIALECT);
    statements = Array.isArray(ast) ? ast : [ast];
    tableList = parser.tableList(sql, DIALECT);
  } catch {
    return reject("query could not be parsed as SQLite");
  }
  if (statements.length !== 1) return reject("multiple statements are not allowed");
  const statement = statements[0] as { type?: unknown };
  if (statement.type !== "select") {
    return reject(`only SELECT is allowed, got ${String(statement.type).toUpperCase()}`);
  }

  const ctes = new Set<string>();
  collectCteNames(statement, ctes);
  const allowed = new Set(options.allowedTables.map((t) => t.toLowerCase()));
  const tables = new Set<string>();
  for (const entry of tableList) {
    const [operation, schema, table] = entry.split("::");
    if (operation?.toLowerCase() !== "select") return reject(`${String(operation)} not allowed`);
    if (schema && schema !== "null")
      return reject(`schema-qualified tables are not allowed: ${schema}`);
    if (!table || table === "null") continue;
    const name = table.toLowerCase();
    if (ctes.has(name)) continue;
    if (!allowed.has(name)) return reject(`table not allowed: ${table}`);
    tables.add(table);
  }

  const functions = new Set<string>();
  collectFunctions(statement, functions);
  for (const fn of functions) {
    if (!ALLOWED_FUNCTIONS.has(fn)) return reject(`function not allowed: ${fn}`);
  }

  return {
    ok: true,
    sql: `SELECT * FROM (\n${sql}\n) LIMIT ${String(MAX_ROWS + 1)}`,
    tables: [...tables],
  };
}
