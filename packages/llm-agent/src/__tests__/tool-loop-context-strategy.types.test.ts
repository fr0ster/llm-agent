import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IToolLoopContextStrategy,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

test('IToolLoopContextStrategy shape compiles and is usable', () => {
  const round: ToolRound = {
    assistant: { role: 'assistant', content: null, tool_calls: [] },
    results: [{ role: 'tool', tool_call_id: 'c1', content: 'r' }],
  };
  const base: ToolLoopContextBase = { prefix: [], queryText: 'q' };
  const state: SerializableStrategyState = { version: 1 };
  const s: IToolLoopContextStrategy = {
    async record() {},
    async form() {
      return base.prefix;
    },
    snapshot: () => state,
    restore: () => {},
  };
  assert.equal(typeof s.form, 'function');
  assert.equal(round.results.length, 1);
});
