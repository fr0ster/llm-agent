import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLARIFY_MARKER } from '@mcp-abap-adt/llm-agent';
import { buildAncestorContext } from '../dag-coordinator.js';

function ctx(
  history: Array<{ role: string; content: string }>,
  inputText: string,
) {
  return { history, inputText } as unknown as Parameters<
    typeof buildAncestorContext
  >[0];
}

describe('buildAncestorContext', () => {
  it('reconstructs Q/A + parent objective on a clarification resume (history includes current)', () => {
    const ac = buildAncestorContext(
      ctx(
        [
          { role: 'user', content: 'create RAP BO for orders' },
          { role: 'assistant', content: `${CLARIFY_MARKER}Which table?` },
          { role: 'user', content: 'ZCUSTOMERS' },
        ],
        'ZCUSTOMERS',
      ),
    );
    assert.equal(ac.objective, 'create RAP BO for orders');
    assert.deepEqual(ac.clarifications, [
      { question: 'Which table?', answer: 'ZCUSTOMERS' },
    ]);
  });

  it('handles history that EXCLUDES the current turn', () => {
    const ac = buildAncestorContext(
      ctx(
        [
          { role: 'user', content: 'goal' },
          { role: 'assistant', content: `${CLARIFY_MARKER}Q?` },
        ],
        'A',
      ),
    );
    assert.equal(ac.objective, 'goal');
    assert.deepEqual(ac.clarifications, [{ question: 'Q?', answer: 'A' }]);
  });

  it('returns a fresh context when the tail is not a marked clarification', () => {
    const ac = buildAncestorContext(
      ctx([{ role: 'user', content: 'just do X' }], 'just do X'),
    );
    assert.equal(ac.objective, 'just do X');
    assert.deepEqual(ac.clarifications, []);
  });
});
