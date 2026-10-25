import { describe, expect, it } from "vitest";
import { MAX_ROWS, guardSql } from "../../src/sql/guard.ts";

const AGENT_TABLES = [
  "Album",
  "Artist",
  "Customer",
  "Genre",
  "Invoice",
  "InvoiceLine",
  "MediaType",
  "Playlist",
  "PlaylistTrack",
  "Track",
  "customer_notes",
];
const guard = (sql: string) => guardSql(sql, { allowedTables: AGENT_TABLES });

/** Write, DDL and other non-read statements. Every single one must be blocked. */
const WRITE_AND_DDL = [
  "INSERT INTO Customer (FirstName, LastName, Email) VALUES ('a', 'b', 'c')",
  "INSERT INTO Genre SELECT * FROM Genre",
  "REPLACE INTO Genre (GenreId, Name) VALUES (1, 'x')",
  "UPDATE Track SET UnitPrice = 0",
  "UPDATE Invoice SET Total = 0 WHERE InvoiceId = 1",
  "DELETE FROM Customer",
  "DELETE FROM Invoice WHERE InvoiceDate < '2010-01-01'",
  "DROP TABLE Customer",
  "DROP VIEW IF EXISTS v",
  "CREATE TABLE x (id INTEGER)",
  "CREATE TABLE x AS SELECT * FROM Customer",
  "CREATE VIEW v AS SELECT * FROM Customer",
  "CREATE INDEX i ON Customer (Email)",
  "CREATE TRIGGER t AFTER INSERT ON Genre BEGIN DELETE FROM Genre; END",
  "ALTER TABLE Customer ADD COLUMN x TEXT",
  "ALTER TABLE Customer RENAME TO c",
  "TRUNCATE TABLE Customer",
  "PRAGMA table_info(Customer)",
  "PRAGMA writable_schema = ON",
  "pragma query_only = off",
  "ATTACH DATABASE 'data/build/sales_manager.sqlite' AS other",
  "ATTACH 'file:vulnerable.sqlite?mode=ro' AS v",
  "DETACH DATABASE other",
  "VACUUM",
  "VACUUM INTO '/tmp/copy.sqlite'",
  "REINDEX",
  "ANALYZE",
  "BEGIN TRANSACTION",
  "COMMIT",
  "SELECT 1; DROP TABLE Customer",
  "SELECT * FROM Customer; DELETE FROM Customer",
  "SELECT 1;\nUPDATE Track SET UnitPrice = 0;",
  "WITH x AS (SELECT 1) DELETE FROM Customer",
  "SELECT load_extension('/tmp/evil.so')",
  "SELECT readfile('/etc/passwd')",
  "SELECT writefile('/tmp/x', 'y')",
];

/** Reads that must still be blocked: other tables, schema discovery, risky functions. */
const FORBIDDEN_READS = [
  "SELECT * FROM Employee",
  "SELECT * FROM employee_comp",
  "SELECT FirstName FROM Customer UNION SELECT FirstName FROM Employee",
  "SELECT * FROM (SELECT * FROM Employee)",
  "SELECT (SELECT Email FROM Employee LIMIT 1)",
  "SELECT * FROM sqlite_master",
  "SELECT name FROM sqlite_schema",
  "SELECT * FROM pragma_table_info('Customer')",
  "SELECT * FROM other.Customer",
  "SELECT randomblob(1000000000)",
  "SELECT zeroblob(1000000000)",
  "SELECT sqlite_version()",
  "SELECT fts3_tokenizer('simple')",
];

const ALLOWED = [
  "SELECT COUNT(*) FROM Customer",
  "select count(*) from customer;",
  "SELECT ROUND(SUM(Total), 2) FROM Invoice WHERE strftime('%Y', InvoiceDate) = '2013'",
  "SELECT c.FirstName, c.LastName, ROUND(SUM(i.Total), 2) AS spend FROM Customer c JOIN Invoice i ON i.CustomerId = c.CustomerId GROUP BY c.CustomerId ORDER BY spend DESC LIMIT 1",
  "SELECT g.Name, COUNT(*) AS n FROM InvoiceLine il JOIN Track t ON t.TrackId = il.TrackId JOIN Genre g ON g.GenreId = t.GenreId GROUP BY g.Name ORDER BY n DESC LIMIT 1",
  "WITH s AS (SELECT CustomerId, SUM(Total) AS total FROM Invoice GROUP BY CustomerId) SELECT c.Country, ROUND(SUM(s.total), 2) FROM s JOIN Customer c USING (CustomerId) GROUP BY c.Country",
  "SELECT BillingCountry, COUNT(*) FROM Invoice GROUP BY BillingCountry HAVING COUNT(*) > 5",
  "SELECT CAST(strftime('%m', InvoiceDate) AS INTEGER) AS month, COALESCE(SUM(Total), 0) FROM Invoice GROUP BY month",
  "SELECT note_text FROM customer_notes WHERE note_text LIKE '%drop table%'",
  "SELECT FirstName FROM Customer -- DROP TABLE Customer",
];

describe("SQL guard: write and DDL statements", () => {
  it.each(WRITE_AND_DDL)("blocks %s", (sql) => {
    expect(guard(sql).ok).toBe(false);
  });

  it(`blocks 100% of the ${String(WRITE_AND_DDL.length)} write/DDL cases`, () => {
    const blocked = WRITE_AND_DDL.filter((sql) => !guard(sql).ok);
    expect(blocked.length / WRITE_AND_DDL.length).toBe(1);
  });
});

describe("SQL guard: forbidden reads", () => {
  it.each(FORBIDDEN_READS)("blocks %s", (sql) => {
    expect(guard(sql).ok).toBe(false);
  });
});

describe("SQL guard: allowed queries", () => {
  it.each(ALLOWED)("allows %s", (sql) => {
    const result = guard(sql);
    expect(result).toMatchObject({ ok: true });
  });

  it("wraps the query in an outer LIMIT of MAX_ROWS + 1", () => {
    const result = guard("SELECT * FROM Track");
    expect(result.ok && result.sql).toBe(
      `SELECT * FROM (\nSELECT * FROM Track\n) LIMIT ${String(MAX_ROWS + 1)}`,
    );
  });

  it("reports the tables it read and ignores CTE names", () => {
    const result = guard(
      "WITH t AS (SELECT * FROM Invoice) SELECT * FROM t JOIN Customer USING (CustomerId)",
    );
    expect(result.ok && [...result.tables].sort()).toEqual(["Customer", "Invoice"]);
  });

  it("rejects empty, oversized and unparsable input", () => {
    expect(guard("   ").ok).toBe(false);
    expect(guard(`SELECT ${"1 + ".repeat(2000)}1`).ok).toBe(false);
    expect(guard("SELEKT * FROM Customer").ok).toBe(false);
  });
});
