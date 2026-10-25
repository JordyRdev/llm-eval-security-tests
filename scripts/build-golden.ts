/**
 * Computes the expected answer of every golden question with its reference SQL on freshly built
 * role databases and writes evals/golden/expected.json. With --check it only verifies that the
 * committed file is up to date (used in CI).
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  EXPECTED_FILE,
  buildExpected,
  formatExpected,
  loadQuestions,
} from "../evals/golden/golden.ts";

const check = process.argv.includes("--check");
const questions = await loadQuestions();
const expected = await buildExpected(questions);
const text = formatExpected(expected);

const counts = Object.fromEntries(
  ["numeric", "categorical", "unanswerable", "refusal"].map((t) => [
    t,
    questions.filter((q) => q.type === t).length,
  ]),
);
console.log(`${String(questions.length)} questions`, counts);

if (check) {
  const current = await readFile(EXPECTED_FILE, "utf8").catch(() => "");
  if (current !== text) {
    console.error("evals/golden/expected.json is out of date. Run: npm run build:golden");
    process.exit(1);
  }
  console.log("expected.json is up to date");
} else {
  await writeFile(EXPECTED_FILE, text);
  console.log(`Wrote ${EXPECTED_FILE}`);
}
