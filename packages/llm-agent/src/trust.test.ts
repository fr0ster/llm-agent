import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeTrustName,
  formatTrust,
  formatTrustTag,
  normalizeTrust,
  toModelToolMessage,
  toModelToolMessages,
} from './trust.js';
import type { Message } from './types.js';

test('trust formatting preserves classes and escapes brackets', () => {
  assert.equal(
    formatTrustTag('user:Notes/r1', 3),
    '[source: user:Notes/r1; trust 3]',
  );
  assert.equal(formatTrustTag(undefined, 4.5), '[source: unknown; trust 4.5]');
  assert.equal(
    formatTrustTag('global:a[b];c', 5),
    '[source: global:a&#91;b&#93;;c; trust 5]',
  );
  assert.equal(escapeTrustName('[x]'), '&#91;x&#93;');
  assert.equal(formatTrust(5.0), '5');
  assert.equal(formatTrust(4.5), '4.5');
});

test('replayed raw rounds resolve tool names independently without accumulating tags', () => {
  const raw: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'value...[truncated]' },
  ];
  const resolver = () => ({ source: 'system:Read', trust: 5 });
  const first = toModelToolMessages(raw, resolver);
  assert.equal(
    first[1].content,
    '[source: system:Read; trust 5]\nvalue...[truncated]',
  );
  assert.deepEqual(toModelToolMessages(raw, resolver), first);
  assert.deepEqual(toModelToolMessages(first, resolver), first);
  assert.equal(raw[1].content, 'value...[truncated]');
  assert.deepEqual(toModelToolMessages(raw), raw);
});

test('normalizeTrust validates without rounding', () => {
  for (const value of [0, 2.5, 4.1, 5])
    assert.equal(normalizeTrust(value), value);
  for (const value of [-1, 5.1, 4.55, Number.NaN, Infinity]) {
    assert.equal(normalizeTrust(value), undefined);
  }
});

test('tool projection tags a copy and preserves raw text and unconfigured messages', () => {
  const raw: Message = {
    role: 'tool',
    tool_call_id: 'call',
    content: 'raw result',
  };
  const resolver = (name: string) =>
    name === 'GetClass' ? { source: 'system:GetClass', trust: 4.5 } : undefined;
  assert.deepEqual(toModelToolMessage(raw, resolver, 'GetClass'), {
    ...raw,
    content: '[source: system:GetClass; trust 4.5]\nraw result',
  });
  assert.equal(raw.content, 'raw result');
  assert.equal(toModelToolMessage(raw), raw);
  assert.equal(toModelToolMessage(raw, resolver, 'Other'), raw);
  const user: Message = { role: 'user', content: 'hello' };
  assert.equal(toModelToolMessage(user, resolver, 'GetClass'), user);
});
