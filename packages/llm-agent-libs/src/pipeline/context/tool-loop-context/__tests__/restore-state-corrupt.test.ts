/**
 * Spec §10.5.2 (D70, D92): a saved context state of another version or of the
 * wrong shape is STATE_CORRUPT — never a silent reset. No saved state at all is
 * absent by design and starts empty.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IToolLoopContextStrategy,
  OrchestratorError,
  PIPELINE_FAILURE_CODES,
  type SerializableStrategyState,
  type ToolRound,
} from '@mcp-abap-adt/llm-agent';
import { LegacyAccumulateContextStrategy } from '../legacy-accumulate-context-strategy.js';
import { LegacyTranscriptContextStrategy } from '../legacy-transcript-context-strategy.js';
import { RagRecallContextStrategy } from '../rag-recall-context-strategy.js';
import { WindowContextStrategy } from '../window-context-strategy.js';

const round: ToolRound = {
  assistant: {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'T', arguments: '{}' } },
    ],
  },
  results: [{ role: 'tool', tool_call_id: 'c1', content: 'r1' }],
};

const NO_STATE = undefined as unknown as SerializableStrategyState;

function assertCorrupt(s: IToolLoopContextStrategy, state: unknown): void {
  assert.throws(
    () => s.restore(state as SerializableStrategyState),
    (e: unknown) =>
      e instanceof OrchestratorError &&
      e.code === PIPELINE_FAILURE_CODES.STATE_CORRUPT,
    `expected STATE_CORRUPT for ${JSON.stringify(state)}`,
  );
}

const makers: Array<{
  name: string;
  make: () => IToolLoopContextStrategy;
  corrupt: unknown[];
  empty: unknown;
}> = [
  {
    name: 'WindowContextStrategy',
    make: () => new WindowContextStrategy(),
    corrupt: [
      { version: 2, rounds: [] },
      { version: 1, rounds: 'x' },
    ],
    empty: { version: 1, rounds: [] },
  },
  {
    name: 'LegacyAccumulateContextStrategy',
    make: () => new LegacyAccumulateContextStrategy(),
    corrupt: [
      { version: 2, rounds: [] },
      { version: 1, rounds: 'x' },
    ],
    empty: { version: 1, rounds: [] },
  },
  {
    name: 'LegacyTranscriptContextStrategy',
    make: () => new LegacyTranscriptContextStrategy({ rawMessages: [] }),
    corrupt: [
      { version: 2, rawMessages: [], newRounds: [] },
      { version: 1, rawMessages: 'x', newRounds: [] },
    ],
    empty: { version: 1, rawMessages: [], newRounds: [] },
  },
  {
    name: 'RagRecallContextStrategy',
    make: () =>
      new RagRecallContextStrategy(
        { record: async () => {}, recall: async () => '' },
        { runId: 'run1' },
      ),
    corrupt: [
      { version: 2, last: null, counter: 0 },
      { version: 1, last: null, counter: 'x' },
      { version: 1, last: [], counter: 0 },
    ],
    empty: { version: 1, last: null, counter: 0 },
  },
];

for (const m of makers) {
  describe(`${m.name}.restore`, () => {
    for (const state of m.corrupt) {
      it(`throws STATE_CORRUPT for ${JSON.stringify(state)} — today a silent reset`, () => {
        assertCorrupt(m.make(), state);
      });
    }

    it('no saved state starts empty (absent by design)', async () => {
      const s = m.make();
      await s.record({
        ...round,
        assistant: { ...round.assistant },
        results: [...round.results],
      });
      s.restore(NO_STATE);
      assert.deepEqual(s.snapshot(), m.empty);
    });

    it('a state it wrote itself restores unchanged', async () => {
      const s = m.make();
      await s.record({
        ...round,
        assistant: { ...round.assistant },
        results: [...round.results],
      });
      const snap = JSON.parse(JSON.stringify(s.snapshot()));
      const s2 = m.make();
      s2.restore(snap);
      assert.deepEqual(JSON.parse(JSON.stringify(s2.snapshot())), snap);
    });
  });
}
