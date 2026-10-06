/**
 * Spec §10.5.2 N13 (D70): pending tool results that failed are an error the
 * consumer receives — never `results: []`, which reads as tools that returned nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import { PendingToolResultsRegistry } from '../pending-tool-results-registry.js';

describe('PendingToolResultsRegistry.consume — a rejected results promise', () => {
  it('rejects with PIPELINE_ERROR naming the tool calls — today results: []', async () => {
    const reg = new PendingToolResultsRegistry();
    const promise = Promise.reject(new Error('lost'));
    promise.catch(() => {}); // observed by consume below
    reg.set('s1', {
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'A', arguments: '{}' },
          },
          {
            id: 'call_b',
            type: 'function',
            function: { name: 'B', arguments: '{}' },
          },
        ],
      },
      promise,
      createdAt: Date.now(),
    });
    await assert.rejects(
      reg.consume('s1'),
      (e: unknown) =>
        e instanceof OrchestratorError &&
        e.code === 'PIPELINE_ERROR' &&
        /call_a/.test(e.message) &&
        /call_b/.test(e.message) &&
        /lost/.test(e.message),
    );
    assert.equal(reg.has('s1'), false, 'the entry is consumed either way');
  });

  it('a resolved promise still returns its results', async () => {
    const reg = new PendingToolResultsRegistry();
    const results = [{ toolCallId: 'call_a', toolName: 'A', text: 'ok' }];
    reg.set('s1', {
      assistantMessage: { role: 'assistant', content: null },
      promise: Promise.resolve(results),
      createdAt: Date.now(),
    });
    const out = await reg.consume('s1');
    assert.deepEqual(out?.results, results);
  });
});
