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

> **Status:** work in progress. Phase 0 (project foundation, CI and the pinned dataset) is done.
> The app, evals and security suite are being built in the phases listed in the roadmap below.

## Roles

Each sales support agent may only see their own customers. Roles will be enforced in the data
(one read-only SQLite file per role), not in the prompt, so even a successful prompt injection
cannot reach another role's rows.

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

## Getting started

Requirements: Node.js 24 LTS (see `.nvmrc`).

```sh
npm ci
npm run check        # lint, typecheck, dataset checksum and unit tests
```

| Script                | What it does                                                 |
| --------------------- | ------------------------------------------------------------ |
| `npm run lint`        | ESLint (typescript-eslint, strict type-checked) and Prettier |
| `npm run typecheck`   | `tsc --noEmit` in strict mode                                |
| `npm test`            | Vitest unit tests                                            |
| `npm run verify:data` | Verifies the pinned dataset against `data/raw/SHA256SUMS`    |

No API keys are needed for the checks above. LLM settings for later phases are documented in
`.env.example`.

## CI

| Workflow | Trigger                       | Jobs                                                 | Secrets |
| -------- | ----------------------------- | ---------------------------------------------------- | ------- |
| `ci.yml` | pull requests, push to `main` | `lint-typecheck`, `unit` (dataset checksum + Vitest) | none    |

Actions are pinned to commit SHAs and the workflow runs with `contents: read` only.

## Roadmap

- [x] **Phase 0, foundation:** TypeScript project, lint, typecheck, CI, pinned dataset, NOTICE
- [ ] **Phase 1, app:** per-role read-only databases, SELECT-only SQL guard, LLM providers
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
