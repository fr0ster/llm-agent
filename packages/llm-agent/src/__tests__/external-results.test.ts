import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExternalResults } from '../external-results.js';
import type { Message } from '../types.js';

function extCall(id: string, name = 'fn') {
  return { id, type: 'function' as const, function: { name, arguments: '{}' } };
}

test('(a) adjacent result accepted and consumed', () => {
  const messages: Message[] = [
    { role: 'assistant', content: null, tool_calls: [extCall('ext:aaa')] },
    { role: 'tool', content: 'R', tool_call_id: 'ext:aaa' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.get('ext:aaa'), 'R');
  assert.equal(sanitizedMessages.length, 0);
});

test('(b) orphan ext tool result rejected and dropped', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'R', tool_call_id: 'ext:bbb' },
  ];
  const { results, sanitizedMessages } = buildExternalResults(messages);
  assert.equal(results.has('ext:bbb'), false);
  // orphan ext tool result is dropped from sanitized, user message remains
  assert.deepEqual(sanitizedMessages, [{ role: 'user', content: 'hi' }]);
});

test('(c) partial set — only matched id in map, whole group stripped', () => {
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
  assert.equal(sanitizedMessages.filter((m) => m.role === 'tool').length, 0);
  assert.equal(
    sanitizedMessages.filter(
      (m) =>
        m.role === 'assistant' &&
        (m.tool_calls ?? []).some((c) => c.id.startsWith('ext:')),
    ).length,
    0,
  );
});

test('(d) multi-tool-per-turn — whole consecutive run consumed', () => {
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
  assert.equal(sanitizedMessages.length, 0);
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
