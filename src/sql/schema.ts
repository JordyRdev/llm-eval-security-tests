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
