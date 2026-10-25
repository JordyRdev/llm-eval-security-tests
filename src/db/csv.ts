/**
 * Minimal RFC 4180 CSV parser for the small synthetic data files (quoted fields, escaped
 * quotes, commas and newlines inside quotes). The first row is the header.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (inQuotes) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  const [header, ...body] = nonEmpty;
  if (!header) return [];
  return body.map((values, index) => {
    if (values.length !== header.length) {
      throw new Error(
        `CSV row ${String(index + 2)} has ${String(values.length)} fields, expected ${String(header.length)}`,
      );
    }
    return Object.fromEntries(header.map((name, j) => [name, values[j] ?? ""]));
  });
}
