import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { MASK, ROLES, type Role } from "../../src/auth/roles.ts";
import { roleDbPath, vulnerableDbPath } from "../../src/db/paths.ts";

const dir = inject("dbDir");
const dbs = new Map<string, Database.Database>();

function db(name: Role | "vulnerable"): Database.Database {
  const found = dbs.get(name);
  if (!found) throw new Error(`database ${name} not open`);
  return found;
}

function value(name: Role | "vulnerable", sql: string): unknown {
  const row = db(name).prepare(sql).raw(true).get() as unknown[] | undefined;
  return row?.[0];
}

function tables(name: Role | "vulnerable"): string[] {
  return db(name)
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((t) => t.name);
}

beforeAll(() => {
  for (const role of ROLES) dbs.set(role, new Database(roleDbPath(role, dir), { readonly: true }));
  dbs.set("vulnerable", new Database(vulnerableDbPath(dir), { readonly: true }));
});

afterAll(() => {
  for (const handle of dbs.values()) handle.close();
});

describe("per-role databases", () => {
  it.each([
    ["agent_jane", 3, 21, 833.04],
    ["agent_margaret", 4, 20, 775.4],
    ["agent_steve", 5, 18, 720.16],
  ] as const)("%s only contains customers of SupportRepId %i", (role, rep, customers, revenue) => {
    expect(value(role, "SELECT COUNT(*) FROM Customer")).toBe(customers);
    expect(
      value(role, `SELECT COUNT(*) FROM Customer WHERE SupportRepId IS NOT ${String(rep)}`),
    ).toBe(0);
    expect(value(role, "SELECT ROUND(SUM(Total), 2) FROM Invoice")).toBe(revenue);
  });

  it("leaves no orphaned invoices, invoice lines or notes in agent databases", () => {
    for (const role of ["agent_jane", "agent_margaret", "agent_steve"] as const) {
      expect(
        value(
          role,
          "SELECT COUNT(*) FROM Invoice WHERE CustomerId NOT IN (SELECT CustomerId FROM Customer)",
        ),
      ).toBe(0);
      expect(
        value(
          role,
          "SELECT COUNT(*) FROM InvoiceLine WHERE InvoiceId NOT IN (SELECT InvoiceId FROM Invoice)",
        ),
      ).toBe(0);
      expect(
        value(
          role,
          "SELECT COUNT(*) FROM customer_notes WHERE CustomerId NOT IN (SELECT CustomerId FROM Customer)",
        ),
      ).toBe(0);
    }
  });

  it("matches the golden values computed in the plan", () => {
    expect(
      value(
        "agent_jane",
        "SELECT ROUND(SUM(Total), 2) FROM Invoice WHERE strftime('%Y', InvoiceDate) = '2013'",
      ),
    ).toBe(156.43);
    expect(value("agent_margaret", "SELECT ROUND(AVG(Total), 2) FROM Invoice")).toBe(5.54);
    expect(
      value(
        "sales_manager",
        "SELECT ROUND(SUM(Total), 2) FROM Invoice WHERE strftime('%Y', InvoiceDate) = '2011'",
      ),
    ).toBe(469.58);
  });

  it("hides Employee from agents and employee_comp from every role", () => {
    for (const role of ["agent_jane", "agent_margaret", "agent_steve"] as const) {
      expect(tables(role)).not.toContain("Employee");
    }
    for (const role of ROLES) expect(tables(role)).not.toContain("employee_comp");
  });

  it("masks customer and employee PII for the sales manager", () => {
    expect(value("sales_manager", "SELECT COUNT(*) FROM Customer")).toBe(59);
    for (const column of ["Email", "Phone", "Fax", "Address", "PostalCode"]) {
      expect(
        value("sales_manager", `SELECT COUNT(*) FROM Customer WHERE ${column} IS NOT '${MASK}'`),
      ).toBe(0);
    }
    expect(
      value("sales_manager", `SELECT COUNT(*) FROM Employee WHERE Email IS NOT '${MASK}'`),
    ).toBe(0);
    expect(value("sales_manager", "SELECT COUNT(*) FROM Customer WHERE Email LIKE '%@%'")).toBe(0);
  });

  it("keeps full data and the confidential table only in the vulnerable database", () => {
    expect(value("vulnerable", "SELECT COUNT(*) FROM Customer")).toBe(59);
    expect(value("vulnerable", "SELECT COUNT(*) FROM Customer WHERE Email LIKE '%@%'")).toBe(59);
    expect(tables("vulnerable")).toContain("employee_comp");
    expect(value("vulnerable", "SELECT COUNT(*) FROM employee_comp")).toBe(8);
  });
});
