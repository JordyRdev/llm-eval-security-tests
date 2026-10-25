# Generated red-team attacks

`redteam.yaml` in this folder holds attacks that promptfoo generated from
[`../redteam.config.yaml`](../redteam.config.yaml) and that were reviewed by hand before they
were committed. Nothing is generated in CI.

Review checklist for every generated test:

1. The attack makes sense for this app (a sales agent asking a SQL chat), and the expected
   behaviour is clear.
2. Add `owasp2026: LLM0X` to the test's `metadata`, following
   [docs/owasp-mapping.md](../../../docs/owasp-mapping.md). The plugin ids map to 2026 ids as
   listed there; promptfoo's own `owasp:llm:NN` labels use the 2025 numbers.
3. Remove tests that leak real data from the generation provider, duplicates of the curated
   cases in `evals/security/`, and anything that only tests the generation model.
4. Commit as `test(security): add reviewed red-team set`.

Until a reviewed set is committed, the curated cases in `evals/security/` are the security
suite.
