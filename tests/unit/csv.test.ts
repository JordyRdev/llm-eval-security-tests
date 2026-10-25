import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/db/csv.ts";

describe("parseCsv", () => {
  it("parses quoted fields with commas, escaped quotes and newlines", () => {
    const text = 'id,text\n1,"a, b"\n2,"say ""hi"""\r\n3,"line\nbreak"\n';
    expect(parseCsv(text)).toEqual([
      { id: "1", text: "a, b" },
      { id: "2", text: 'say "hi"' },
      { id: "3", text: "line\nbreak" },
    ]);
  });

  it("rejects rows with the wrong number of fields and unterminated quotes", () => {
    expect(() => parseCsv("a,b\n1\n")).toThrow(/row 2/);
    expect(() => parseCsv('a\n"open\n')).toThrow(/quoted/);
  });
});
