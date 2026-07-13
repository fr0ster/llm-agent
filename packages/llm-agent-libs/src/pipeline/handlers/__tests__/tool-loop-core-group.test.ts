import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBlockedToolMessages,
  buildHallucinatedToolMessages,
} from '../tool-loop-core.js';

test('buildBlockedToolMessages returns an {assistant, results} group', () => {
  const g = buildBlockedToolMessages('assistant-content', [
    { id: 'c1', name: 'X', arguments: {} },
  ] as never);
  assert.equal(g.assistant.role, 'assistant');
  assert.ok(Array.isArray(g.results));
  assert.equal(g.results[0].role, 'tool');
});

test('buildBlockedToolMessages assistant has the content and tool_calls', () => {
  const g = buildBlockedToolMessages('my-content', [
    { id: 'c2', name: 'Foo', arguments: { a: 1 } },
  ] as never);
  assert.equal((g.assistant as { content: string }).content, 'my-content');
  const tc = (g.assistant as { tool_calls: { id: string }[] }).tool_calls;
  assert.equal(tc[0].id, 'c2');
});

test('buildBlockedToolMessages results are tool-error messages', () => {
  const g = buildBlockedToolMessages('', [
    { id: 'c3', name: 'Bar', arguments: {} },
  ] as never);
  assert.ok((g.results[0] as { content: string }).content.includes('Bar'));
  assert.equal((g.results[0] as { tool_call_id: string }).tool_call_id, 'c3');
});

test('buildHallucinatedToolMessages returns an {assistant, results} group', () => {
  const call = { id: 'h1', name: 'Ghost', arguments: {} };
  const g = buildHallucinatedToolMessages(
    'txt',
    [call] as never,
    [call] as never,
  );
  assert.equal(g.assistant.role, 'assistant');
  assert.ok(Array.isArray(g.results));
  assert.equal(g.results[0].role, 'tool');
  assert.ok((g.results[0] as { content: string }).content.includes('Ghost'));
});
