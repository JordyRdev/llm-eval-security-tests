import Database from "better-sqlite3";

interface ColumnInfo {
  name: string;
  type: string;
  pk: number;
}

export function listTables(file: string): string[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

/**
 * Compact schema for the prompt, one line per table: `Table(Col TYPE PK, Col, ...)`.
 * Types are shortened and only kept where they help the model write correct SQL.
 */
export function describeSchema(file: string): string {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    return tables
      .map(({ name }) => {
        const columns = db
          .prepare<[], ColumnInfo>(`SELECT name, type, pk FROM pragma_table_info('${name}')`)
          .all()
          .map((c) => {
            const type = c.type.replace(/\(.*\)/, "").replace("NVARCHAR", "TEXT");
            return `${c.name} ${type}${c.pk ? " PK" : ""}`.trim();
          });
        return `${name}(${columns.join(", ")})`;
      })
      .join("\n");
  } finally {
    db.close();
  }
}

/** First and last year with invoices, or null when the database has no Invoice table. */
export function invoiceYears(file: string): { min: number; max: number } | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const hasInvoice = db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'Invoice'",
      )
      .get();
    if (!hasInvoice?.n) return null;
    const row = db
      .prepare<[], { min: string | null; max: string | null }>(
        "SELECT MIN(strftime('%Y', InvoiceDate)) AS min, MAX(strftime('%Y', InvoiceDate)) AS max FROM Invoice",
      )
      .get();
    if (!row?.min || !row.max) return null;
    return { min: Number(row.min), max: Number(row.max) };
  } finally {
    db.close();
  }
}

/** Lowercased first and last names of the customers in the database (empty without Customer). */
export function customerNames(file: string): Set<string> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const hasCustomer = db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'Customer'",
      )
      .get();
    if (!hasCustomer?.n) return new Set();
    const names = new Set<string>();
    const rows = db
      .prepare<[], { first: string | null; last: string | null }>(
        "SELECT FirstName AS first, LastName AS last FROM Customer",
      )
      .all();
    for (const { first, last } of rows) {
      for (const part of [first, last]) {
        if (part) names.add(part.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase());
      }
    }
    return names;
  } finally {
    db.close();
  }
}
