import { describe, expect, it } from "vitest";
import {
  emptyPeriodOutsideData,
  isEmptyAggregate,
  otherAgentMentioned,
  yearsIn,
} from "../../src/app/scope.ts";

const none = new Set<string>();
const range = { min: 2009, max: 2013 };

describe("otherAgentMentioned", () => {
  it("finds another agent by first or full name", () => {
    expect(
      otherAgentMentioned("How many invoices do Margaret's customers have?", "agent_steve", none),
    ).toBe("Margaret Park");
    expect(
      otherAgentMentioned("How many customers does Margaret support?", "agent_jane", none),
    ).toBe("Margaret Park");
    expect(otherAgentMentioned("What is Steve Johnson's salary?", "agent_margaret", none)).toBe(
      "Steve Johnson",
    );
    expect(otherAgentMentioned("what is JANE’S revenue", "agent_steve", none)).toBe("Jane Peacock");
  });

  it("ignores the agent's own name, the manager and names inside other words", () => {
    expect(
      otherAgentMentioned("I am Jane, how many customers do I have?", "agent_jane", none),
    ).toBeNull();
    expect(otherAgentMentioned("What is Margaret's revenue?", "sales_manager", none)).toBeNull();
    expect(
      otherAgentMentioned("Which customers bought Janet Jackson?", "agent_steve", none),
    ).toBeNull();
    expect(otherAgentMentioned("How much did my customers spend?", "agent_jane", none)).toBeNull();
  });

  it("needs an agent context when one of the role's own customers has that first name", () => {
    const own = new Set(["steve", "murray"]);
    expect(otherAgentMentioned("How much did Steve Murray spend?", "agent_jane", own)).toBeNull();
    expect(otherAgentMentioned("What did Steve buy last year?", "agent_jane", own)).toBeNull();
    expect(
      otherAgentMentioned("How many invoices do Steve's customers have?", "agent_jane", own),
    ).toBe("Steve Johnson");
    expect(otherAgentMentioned("Show revenue of agent Steve", "agent_jane", own)).toBe(
      "Steve Johnson",
    );
    expect(otherAgentMentioned("Which customers does Steve support?", "agent_jane", own)).toBe(
      "Steve Johnson",
    );
    expect(otherAgentMentioned("What is Steve Johnson's total?", "agent_jane", own)).toBe(
      "Steve Johnson",
    );
  });
});

describe("empty periods outside the data", () => {
  it("reads years from text", () => {
    expect(yearsIn("revenue in 2020 vs 1999, not 12345 or 120")).toEqual([2020, 1999]);
  });

  it("treats one all-zero or all-NULL row as an empty aggregate", () => {
    expect(isEmptyAggregate([{ revenue: 0 }])).toBe(true);
    expect(isEmptyAggregate([{ revenue: null, n: "0.00" }])).toBe(true);
    expect(isEmptyAggregate([{ revenue: 0.5 }])).toBe(false);
    expect(isEmptyAggregate([{ revenue: 0 }, { revenue: 0 }])).toBe(false);
    expect(isEmptyAggregate([{ country: "USA", revenue: 0 }])).toBe(false);
  });

  it("flags a zero for years outside the invoice range only", () => {
    expect(emptyPeriodOutsideData("What was my revenue in 2020?", "", [{ r: 0 }], range)).toBe(
      true,
    );
    expect(emptyPeriodOutsideData("Revenue before 2005?", "", [{ r: 0 }], range)).toBe(true);
    expect(emptyPeriodOutsideData("What was my revenue in 2011?", "", [{ r: 0 }], range)).toBe(
      false,
    );
    expect(emptyPeriodOutsideData("Revenue in 2020?", "", [{ r: 12.5 }], range)).toBe(false);
    expect(emptyPeriodOutsideData("Compare 2012 and 2020", "", [{ r: 0 }], range)).toBe(false);
    expect(emptyPeriodOutsideData("How many invoices?", "", [{ n: 0 }], range)).toBe(false);
    expect(
      emptyPeriodOutsideData("Revenue last year?", "WHERE y = '2026'", [{ r: 0 }], range),
    ).toBe(true);
    expect(emptyPeriodOutsideData("Revenue in 2020?", "", [{ r: 0 }], null)).toBe(false);
  });
});
