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

> **Status:** work in progress. Phase 0 (foundation) and Phase 1 (the app) are done. The evals
> and security suite are being built in the phases listed in the roadmap below.

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
| `replay`       | recorded replies (`evals/…`) | Deterministic, no network; used by the evals in Phase 2     |

The Groq limiter keeps requests within 30 RPM, 8K TPM, 1K RPD and 200K TPD, runs one request at
a time and retries 429 and 5xx responses with backoff.

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
```

With a Groq key, set `LLM_PROVIDER=groq` and `GROQ_API_KEY` in `.env` instead.

| Script                | What it does                                                    |
| --------------------- | --------------------------------------------------------------- |
| `npm run lint`        | ESLint (typescript-eslint, strict type-checked) and Prettier    |
| `npm run typecheck`   | `tsc --noEmit` in strict mode, for the server and the browser   |
| `npm test`            | Vitest unit tests (no network, scripted model replies)          |
| `npm run verify:data` | Verifies the pinned dataset against `data/raw/SHA256SUMS`       |
| `npm run build:db`    | Builds the per-role and vulnerable databases into `data/build/` |
| `npm start`           | Starts the chat API and UI                                      |
| `npm run smoke`       | Asks five questions through the real pipeline and times them    |

No API keys are needed for the checks above. All settings are documented in `.env.example`.

`data/synthetic/` holds two small synthetic tables that are not part of Chinook:
`customer_notes` (free-text notes, used later for indirect prompt injection tests) and
`employee_comp` (fake salaries, only in the vulnerable database).

## CI

| Workflow | Trigger                       | Jobs                                                                        | Secrets |
| -------- | ----------------------------- | --------------------------------------------------------------------------- | ------- |
| `ci.yml` | pull requests, push to `main` | `lint-typecheck`, `unit` (checksum, build:db, Vitest), `ollama-smoke` (CPU) | none    |

`ollama-smoke` runs the real pipeline against `qwen3:4b` on the hosted runner and writes the
answers and timings to the job summary. It fails only when the pipeline breaks, not on
accuracy; accuracy is gated by the evals in Phase 2.

Actions are pinned to commit SHAs and the workflow runs with `contents: read` only.

## Roadmap

- [x] **Phase 0, foundation:** TypeScript project, lint, typecheck, CI, pinned dataset, NOTICE
- [x] **Phase 1, app:** per-role read-only databases, SELECT-only SQL guard, LLM providers
      (Groq, Ollama, replay), chat API and minimal UI, hardened and vulnerable modes
- [ ] **Phase 2, evals:** golden questions with SQL-computed answers, accuracy and grounding
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
