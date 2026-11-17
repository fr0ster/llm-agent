import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExternalResults } from '../external-results.js';
import type { Message } from '../types.js';

function extCall(id: string, name = 'fn') {
  return { id, type: 'function' as const, function: { name, arguments: '{}' } };
}

test('(a) adjacent result cached and preserved', () => {
  const messages: Message[] = [
    { role: 'assistant', content: null, tool_calls: [extCall('ext:aaa')] },
    { role: 'tool', content: 'R', tool_call_id: 'ext:aaa' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.get('ext:aaa'), 'R');
  assert.deepEqual(sanitizedMessages, messages);
});

test('(b) orphan ext tool result excluded from cache but preserved', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'R', tool_call_id: 'ext:bbb' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.has('ext:bbb'), false);
  assert.deepEqual(sanitizedMessages, messages);
});

test('(c) partial set: only matched id cached, full history preserved', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [extCall('ext:a'), extCall('ext:b')],
    },
    { role: 'tool', content: 'RA', tool_call_id: 'ext:a' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.get('ext:a'), 'RA');
  assert.equal(results.has('ext:b'), false);
  assert.deepEqual(sanitizedMessages, messages);
});

test('(d) multiple tools: whole consecutive run cached and preserved', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [extCall('ext:a'), extCall('ext:b')],
    },
    { role: 'tool', content: 'RA', tool_call_id: 'ext:a' },
    { role: 'tool', content: 'RB', tool_call_id: 'ext:b' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.get('ext:a'), 'RA');
  assert.equal(results.get('ext:b'), 'RB');
  assert.deepEqual(sanitizedMessages, messages);
});

test('(e) non-external messages and internal tool_calls untouched', () => {
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'an answer' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [extCall('call_internal_1')],
    },
    { role: 'tool', content: 'IR', tool_call_id: 'call_internal_1' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.size, 0);
  assert.deepEqual(sanitizedMessages, messages);
});

test('mixed internal and external results are cached without changing history', () => {
  const messages: Message[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: 'ASSISTANT_HISTORY_SENTINEL',
      tool_calls: [extCall('ext:a'), extCall('internal'), extCall('ext:b')],
    },
    { role: 'tool', content: 'INTERNAL_RESULT', tool_call_id: 'internal' },
    { role: 'tool', content: 'TOOL_HISTORY_SENTINEL', tool_call_id: 'ext:a' },
    { role: 'tool', content: 'SECOND_RESULT', tool_call_id: 'ext:b' },
    { role: 'user', content: 'continue' },
  ];
  const snapshot = structuredClone(messages);
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.deepEqual(
    [...results],
    [
      ['ext:a', 'TOOL_HISTORY_SENTINEL'],
      ['ext:b', 'SECOND_RESULT'],
    ],
  );
  assert.deepEqual(sanitizedMessages, snapshot);
  assert.deepEqual(messages, snapshot);
  assert.notEqual(sanitizedMessages, messages);
});

test('an interrupted external result is not cached and no content is dropped', () => {
  const messages: Message[] = [
    { role: 'assistant', content: 'call', tool_calls: [extCall('ext:a')] },
    { role: 'user', content: 'interrupt' },
    { role: 'tool', tool_call_id: 'ext:a', content: 'late' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.size, 0);
  assert.deepEqual(sanitizedMessages, messages);
});
