import { afterAll, describe, expect, inject, it } from "vitest";
import { roleDbPath } from "../../src/db/paths.ts";
import { QueryError, QueryRunner, QueryTimeoutError } from "../../src/sql/execute.ts";
import { MAX_ROWS, guardSql } from "../../src/sql/guard.ts";
import { describeSchema, listTables } from "../../src/sql/schema.ts";

const file = roleDbPath("agent_jane", inject("dbDir"));
const runner = new QueryRunner(file, 2000);
const tables = listTables(file);

function guarded(sql: string): string {
  const result = guardSql(sql, { allowedTables: tables });
  if (!result.ok) throw new Error(result.reason);
  return result.sql;
}

afterAll(() => {
  runner.close();
});

describe("QueryRunner", () => {
  it("returns rows as objects with column names", async () => {
    const result = await runner.run(guarded("SELECT COUNT(*) AS customers FROM Customer"));
    expect(result.rows).toEqual([{ customers: 21 }]);
    expect(result.columns).toEqual(["customers"]);
    expect(result.truncated).toBe(false);
  });

  it(`caps results at ${String(MAX_ROWS)} rows and flags truncation`, async () => {
    const result = await runner.run(guarded("SELECT TrackId FROM Track"));
    expect(result.rows).toHaveLength(MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("refuses writes even when the guard is bypassed (read-only connection)", async () => {
    await expect(runner.run("INSERT INTO Genre (Name) VALUES ('x')")).rejects.toBeInstanceOf(
      QueryError,
    );
    await expect(runner.run("DROP TABLE Genre")).rejects.toBeInstanceOf(QueryError);
    const genres = await runner.run(guarded("SELECT COUNT(*) AS n FROM Genre"));
    expect(genres.rows).toEqual([{ n: 25 }]);
  });

  it("kills a query that exceeds the timeout and keeps working afterwards", async () => {
    const slow = new QueryRunner(file, 300);
    try {
      const started = Date.now();
      await expect(
        slow.run(
          guarded("SELECT SUM(a.Milliseconds * b.UnitPrice) FROM Track a, Track b, InvoiceLine c"),
        ),
      ).rejects.toBeInstanceOf(QueryTimeoutError);
      expect(Date.now() - started).toBeLessThan(2000);
      const after = await slow.run(guarded("SELECT 1 AS ok"));
      expect(after.rows).toEqual([{ ok: 1 }]);
    } finally {
      slow.close();
    }
  });
});

describe("describeSchema", () => {
  it("lists every table of the role database on one line each", () => {
    const schema = describeSchema(file);
    expect(schema.split("\n")).toHaveLength(tables.length);
    expect(schema).toContain("Customer(CustomerId INTEGER PK");
    expect(schema).not.toContain("Employee(");
  });
});
