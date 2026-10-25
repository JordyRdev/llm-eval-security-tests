# llm-eval-security-tests

[![ci](https://github.com/JordyRdev/llm-eval-security-tests/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JordyRdev/llm-eval-security-tests/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

How do you test an AI feature that writes SQL on your data?

This repository contains a small text-to-SQL "ask your data" chat for the sales team of a
digital music store, built on the public [Chinook](https://github.com/lerocha/chinook-database)
database, and, more importantly, the test suite around it:

- **LLM evaluation**: golden questions whose expected answers are computed with reference SQL on
  the database (never by a model), scored for accuracy and for made-up numbers.
- **AI security tests** mapped to the
  [OWASP Top 10 for LLM Applications 2026](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/):
  prompt injection, data leakage between roles, system prompt leakage, excessive agency and
  improper output handling.
- **A deliberately vulnerable mode** (`APP_MODE=vulnerable`) that the suite must catch, to prove
  the tests detect real leaks.
- **CI/CD quality gates** in GitHub Actions: deterministic checks on every PR, a real LLM on
  `main` and nightly, and a public report on GitHub Pages.

> **Status:** work in progress. Phase 0 (foundation), Phase 1 (the app) and Phase 2 (the evals)
> are done. The security suite and the LLM gates follow in the phases listed in the roadmap below.

## Roles

Each sales support agent may only see their own customers. Roles are enforced in the data (one
read-only SQLite file per role, built by `npm run build:db`), not in the prompt, so even a
successful prompt injection cannot reach another role's rows. Agents do not get the `Employee`
table at all.

| Role             | Sees customers     | PII columns                                             |
| ---------------- | ------------------ | ------------------------------------------------------- |
| `agent_jane`     | `SupportRepId = 3` | Visible (own customers)                                 |
| `agent_margaret` | `SupportRepId = 4` | Visible (own customers)                                 |
| `agent_steve`    | `SupportRepId = 5` | Visible (own customers)                                 |
| `sales_manager`  | All                | `Email`, `Phone`, `Fax`, `Address`, `PostalCode` masked |

## Dataset

`data/raw/Chinook_Sqlite.sqlite` is the Chinook v1.4.5 release asset (MIT, see [NOTICE](NOTICE)):
11 tables, 59 fictitious customers, 412 invoices (2009-01-01 to 2013-12-22) and 3 sales support
agents. The file is pinned by SHA-256 in `data/raw/SHA256SUMS`; `npm run verify:data` and CI fail
if it is missing or modified.

## How the app works

```text
question ─► input guard ─► LLM: write SQL ─► SQL guard ─► read-only query on the role's DB
                                                                     │
answer JSON ◄── output guard ◄── LLM: answer from the rows only ◄────┘
```

1. **Input guard:** Unicode normalisation, invisible characters stripped, at most 1000 characters.
2. **SQL step:** the model gets the role's schema and returns `{"sql": ...}` or a refusal.
3. **SQL guard** (`src/sql/guard.ts`): exactly one `SELECT` (CTEs allowed), only the role's
   tables, an allowlist of functions, no `PRAGMA`/`ATTACH`/schema tables, at most 200 rows.
4. **Query:** runs in a child process on a read-only connection (`query_only`) and is killed
   after 2 seconds.
5. **Answer step:** the model phrases the answer from the rows. Empty results are refused as
   "not in data" without asking the model.
6. **Output guard:** markdown images and links are removed, the UI only uses `textContent`.

A question costs at most 3 model calls (one SQL retry when the guard or the database rejects
the query). The response follows one contract:

```json
{
  "answer": "You have 21 customers.",
  "value": 21,
  "unit": "customers",
  "sql": "SELECT COUNT(*) AS customers FROM Customer",
  "rows_used": [{ "customers": 21 }],
  "refused": false
}
```

Refusals set `refused: true` with `reason` `"not in data"` or `"outside your role"`.

### Modes

| `APP_MODE`           | Database                                     | Role boundary  | Input/output guards |
| -------------------- | -------------------------------------------- | -------------- | ------------------- |
| `hardened` (default) | one per role                                 | in the data    | on                  |
| `vulnerable`         | one shared copy with all PII and salary data | in prompt only | off                 |

The vulnerable mode is a deliberately weak baseline for the security suite. It keeps the
SELECT-only guard and the read-only connection so it can never modify data.

### LLM providers

All providers use the OpenAI-compatible chat API with temperature 0 and JSON mode.

| `LLM_PROVIDER` | Model                        | Notes                                                       |
| -------------- | ---------------------------- | ----------------------------------------------------------- |
| `groq`         | `openai/gpt-oss-120b`        | Needs `GROQ_API_KEY`; client-side limiter for the free plan |
| `ollama`       | `qwen3:4b`                   | Local fallback, no key; default when no Groq key is set     |
| `replay`       | recorded replies (`evals/…`) | Deterministic, no network; used by `eval-replay` in CI      |

The Groq limiter keeps requests within 30 RPM, 8K TPM, 1K RPD and 200K TPD, runs one request at
a time and retries 429 and 5xx responses with backoff.

## Evals

The golden set is 40 hand-written questions in `evals/golden/questions.yaml`: 26 numeric, 6
categorical, 4 that the data cannot answer and 4 outside the asking role. Each question has a
reference SQL query; `npm run build:golden` builds fresh role databases from the pinned file,
runs every query and writes the expected answers to `evals/golden/expected.json`. A model never
decides what is correct. The build fails when a categorical question has no unique winner or when
the reference for an unanswerable question finds data; CI checks that `expected.json` is up to
date.

[promptfoo](https://www.promptfoo.dev) (0.125.1, pinned) runs the questions through the real
pipeline (`evals/providers/app-provider.ts`) and scores each reply with our own deterministic
scorers in `evals/scorers/`, plus one model-graded check:

| Metric                       | How                                                                                | Target PR (12) | Target nightly (40) |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------------- | ------------------- |
| Accuracy                     | `value` within the tolerance (0 for counts, 0.01 for money) or the same name       | ≥ 11 of 12     | ≥ 90 %              |
| Made-up content              | every number in `answer` must be in `rows_used` (rounding allowed) or the question | 0              | ≤ 2 %               |
| Unanswerable and out-of-role | `refused: true`, no `value` and no invented number                                 | 100 %          | ≥ 95 %              |
| Faithfulness (judge)         | `llm-rubric` with `evals/judge/faithfulness.md`, score 0–1                         | —              | mean ≥ 0.85         |

The judge is a different model than the app: `qwen/qwen3.8-27b` on Groq, or `llama3.2:3b` on
Ollama (`JUDGE_PROVIDER`, `JUDGE_MODEL`). Targets are reported in the job summary for now and
become a gate in Phase 4.

Subsets (`EVAL_SUBSET`): `full` is all 40, `pr` is GQ-001 to GQ-012 (the Groq PR gate in
Phase 4), `fork` is 8 cases (6 answerable, 2 refusals) for the keyless Ollama run.

### Replay

`npm run eval:record` saves every app reply and judge verdict to `evals/recordings/app.json` and
`judge.json`. `npm run eval:replay` replays them without a model or a key, so it runs in forks;
it fails on a missing recording and when any per-case score differs from
`evals/recordings/baseline.json`. Changing a prompt, the schema or a question changes the request
hash, so the recordings must be made again.

The committed recordings come from Ollama (`qwen3:4b` for the app, `llama3.2:3b` as judge) on a
CPU, not from Groq. Their scores show what a 4B model does, not the targets:

| Metric (40 cases, replay)    | Result                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Accuracy                     | 33 of 40 (82.5 %)                                                                                                                        |
| Made-up content              | 2 of 40 (5.0 %): a garbled year, and a date range taken from the SQL                                                                     |
| Unanswerable and out-of-role | 4 of 8 (50 %): "streams" answered from purchases, a 100 % profit margin, and "0" instead of a refusal for another agent's data (no leak) |
| Faithfulness (judge)         | mean 0.75 over 32; the 3B judge also marks correct answers as unfaithful                                                                 |

With `qwen3:4b` as its own judge the mean is 1.00 on the same replies, which is why the judge is
a different model family. Re-record with Groq with the `eval-live` workflow (see CI).

## Getting started

Requirements: Node.js 24 LTS (see `.nvmrc`).

```sh
npm ci
npm run check        # lint, typecheck, dataset checksum and unit tests
npm run build:db     # build the role databases into data/build/
```

To run the chat locally without any API key, install [Ollama](https://ollama.com) and:

```sh
ollama pull qwen3:4b
cp .env.example .env # LLM_PROVIDER=ollama
npm start            # http://127.0.0.1:3000
npm run smoke        # five questions through the real pipeline, with timings
npm run eval         # golden set through the real pipeline (EVAL_SUBSET=fork for 8 cases)
npm run eval:summary # metrics and per-case table from out/results.json
```

The local judge needs `ollama pull llama3.2:3b`; `EVAL_JUDGE=0` skips it.

With a Groq key, set `LLM_PROVIDER=groq` and `GROQ_API_KEY` in `.env` instead.

| Script                 | What it does                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `npm run lint`         | ESLint (typescript-eslint, strict type-checked) and Prettier                      |
| `npm run typecheck`    | `tsc --noEmit` in strict mode, for the server and the browser                     |
| `npm test`             | Vitest unit tests (no network, scripted model replies)                            |
| `npm run verify:data`  | Verifies the pinned dataset against `data/raw/SHA256SUMS`                         |
| `npm run build:db`     | Builds the per-role and vulnerable databases into `data/build/`                   |
| `npm start`            | Starts the chat API and UI                                                        |
| `npm run smoke`        | Asks five questions through the real pipeline and times them                      |
| `npm run build:golden` | Computes `evals/golden/expected.json` with the reference SQL (`-- --check` in CI) |
| `npm run eval`         | Runs the golden set with promptfoo into `out/results.json`                        |
| `npm run eval:summary` | Prints the metrics and writes them to the GitHub job summary                      |
| `npm run eval:record`  | Runs the eval live and saves the replies for replay                               |
| `npm run eval:replay`  | Replays the recordings and compares the scores with the baseline                  |

No API keys are needed for the checks above. All settings are documented in `.env.example`.

`data/synthetic/` holds two small synthetic tables that are not part of Chinook:
`customer_notes` (free-text notes, used later for indirect prompt injection tests) and
`employee_comp` (fake salaries, only in the vulnerable database).

## CI

| Workflow        | Trigger                       | Jobs                                                                                                     | Secrets                             |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `ci.yml`        | pull requests, push to `main` | `lint-typecheck`, `unit` (checksum, build:db, golden check, Vitest), `eval-replay`, `ollama-smoke` (CPU) | none                                |
| `eval-live.yml` | manual, Mondays 04:17 UTC     | `groq-record` (full golden set live on Groq, records replies)                                            | `GROQ_API_KEY` in environment `llm` |

- `eval-replay` runs all 40 golden cases with the recorded replies and judge verdicts in a few
  seconds and fails on errors, replay misses or a score that differs from the baseline.
- `ollama-smoke` runs the 8-case `fork` subset live against `qwen3:4b` on the hosted runner,
  without a judge, and reports accuracy against the 60 % target. It fails only when the pipeline
  breaks. On the first green run (25 Oct 2026, the Phase 1 five-question smoke) the runner took
  22.8 s per question on average and 33.0 s at most, with 0 pipeline errors and about 4 minutes
  for the whole job; the 8 cases add about 3 minutes.

### Live eval on Groq

`eval-live.yml` runs all 40 golden cases against `openai/gpt-oss-120b` with `qwen/qwen3.8-27b` as
judge, one call at a time through the free-plan limiter (429 and 5xx are retried with backoff).
It writes the live metrics to the job summary, replays the new recordings against the scores they
produced, and uploads the recordings, the proposed `baseline.json` and the raw results as the
artifact `groq-live-recordings`. Nothing is committed by the workflow. Without the
`GROQ_API_KEY` secret in the `llm` environment (forks) it skips with a notice and passes.

```sh
gh workflow run eval-live.yml --ref main
run=$(gh run list --workflow eval-live.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$run"
gh run download "$run" --name groq-live-recordings # in the repo root: overwrites evals/recordings/
npm run eval:replay                                # same check as CI
git add evals/recordings && git commit -m "test(evals): re-record golden replies on Groq"
```

Actions are pinned to commit SHAs and the workflows run with `contents: read` only.

## Roadmap

- [x] **Phase 0, foundation:** TypeScript project, lint, typecheck, CI, pinned dataset, NOTICE
- [x] **Phase 1, app:** per-role read-only databases, SELECT-only SQL guard, LLM providers
      (Groq, Ollama, replay), chat API and minimal UI, hardened and vulnerable modes
- [x] **Phase 2, evals:** golden questions with SQL-computed answers, accuracy and grounding
      scorers, judge rubric, deterministic replay
- [ ] **Phase 3, security:** curated cases per OWASP 2026 ID, canary data, red-team config,
      vulnerable-mode baseline
- [ ] **Phase 4, CI gates:** LLM quality gate, nightly eval, GitHub Pages report, Dependabot
- [ ] **Phase 5, showcase:** Playwright E2E, results, architecture diagram, release `v1.0.0`

## What this project does not claim

- It does not claim the app is "secure", only that it is tested against the documented cases.
- It does not claim full OWASP coverage: LLM09 (vector and embedding weaknesses) does not apply
  because there is no RAG, LLM04 (supply chain) is covered by process only.
- It is a portfolio project on public, fictitious data, not production or client work.

## License

[MIT](LICENSE) © JordyRdev. Third-party notices are in [NOTICE](NOTICE).
