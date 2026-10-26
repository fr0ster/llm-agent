# Usage Request Shape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `llm.call` record carries the size of the context it sent: messages per role, characters, tool definitions.

**Architecture:** One core helper measures the messages and tools a provider received; each provider spreads its result into the base facts of its physical request, so retries and errors carry it too. The CSV exporter gets the new columns.

**Tech Stack:** TypeScript, node:test, Changesets.

**Spec:** `docs/superpowers/specs/2026-10-25-usage-analytics-design.md`, revision 5: the `LlmCall` fields and the rule "Request shape".

## Global Constraints

- Additive, optional fields only; no recorder given → behaviour identical to today.
- Sizes only: the helper counts, it never copies or records content.
- Characters are `string.length`.

## Review Focus

1. Messages with `content: null` (assistant tool-call turns) count only their tool calls, and do not throw.
2. A large tool array repeated across requests is serialized once (cached per array).
3. A streaming request closed early still records its shape.

---

### Task 1: `requestShape` and provider wiring

**Files:**
- Modify: `packages/llm-agent/src/interfaces/usage.ts` (the `LlmCall` fields of the spec).
- Create: `packages/llm-agent/src/usage/request-shape.ts`, exported from the package index.
- Modify: `packages/openai-llm/src/openai-provider.ts` (covers DeepSeek and Ollama, which extend it), `packages/anthropic-llm/src/anthropic-provider.ts`, `packages/sap-aicore-llm/src/sap-core-ai-provider.ts`: spread `requestShape(messages, tools)` into every `base` passed for usage.
- Modify: `packages/llm-usage/src/read.ts`: `USAGE_CSV_COLUMNS` gains `inputMessages`, `systemChars`, `userChars`, `assistantChars`, `toolChars`, `toolDefs`, `toolDefsChars` (`inputChars` exists).
- Test: `packages/llm-agent/src/usage/request-shape.test.ts`; the existing usage tests of each provider package; `packages/llm-usage/src/usage.test.ts`.

**Interfaces (Produces):** `requestShape(messages: readonly Message[], tools?: readonly unknown[]): RequestShape`, where `RequestShape` is `Pick<LlmCall, 'inputMessages' | 'inputChars' | 'systemChars' | 'userChars' | 'assistantChars' | 'toolChars' | 'toolDefs' | 'toolDefsChars'>`, all fields set (zeros, not undefined; `toolDefs: 0`, `toolDefsChars: 0` without tools).

- [ ] **Step 1: Failing tests:**
  - one message per role: each role's chars equal its content length; `inputChars` is their sum; `inputMessages` 4;
  - an assistant message with `content: null` and two tool calls counts the `name` and `arguments` lengths;
  - tools: `toolDefs` is the array length, `toolDefsChars` the `JSON.stringify` length; the same array twice is stringified once (spy);
  - each provider (OpenAI, Anthropic, SAP AI Core; streaming and non-streaming): the `llm.call` record has the shape of the messages and tools passed, also on an error and on a throttle retry (two records, both with the shape);
  - CSV export has the new columns with the values.
- [ ] **Steps 2–5:** fail → implement → pass (`node --import tsx/esm --test --test-concurrency=1 "src/**/*.test.ts"` in each changed package) → commit `feat(usage): record the request shape of LLM calls`.
- [ ] **Step 6:** `docs/USAGE_ANALYTICS.md`: a short paragraph on the request shape. Changeset: minor for `llm-agent`, `llm-usage`, and the three provider packages; DeepSeek and Ollama get the internal-dependency patch.
