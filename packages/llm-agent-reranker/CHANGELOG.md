# Changelog

## [Unreleased]

- New package: every reranker of the llm-agent family, vendor-neutral. `ProbabilityReranker` (was `DecisionReranker` in `llm-agent-libs`), `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION` moved here; `RelevanceReranker` is new. `llm-agent-libs` no longer exports any of them and keeps no old name (a major release).
