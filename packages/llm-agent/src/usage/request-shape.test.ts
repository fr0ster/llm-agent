import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../types.js';
import { requestShape } from './request-shape.js';

test('counts each role and totals using UTF-16 lengths', () => {
  assert.deepEqual(
    requestShape([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '??' },
      { role: 'assistant', content: 'answer' },
      { role: 'tool', content: 'result' },
      { role: 'user', content: 'two' },
    ]),
    {
      inputMessages: 5,
      systemMessages: 1,
      userMessages: 2,
      assistantMessages: 1,
      toolMessages: 1,
      inputChars: 20,
      systemChars: 3,
      userChars: 5,
      assistantChars: 6,
      toolChars: 6,
      toolDefs: 0,
      toolDefsChars: 0,
    },
  );
});

test('null assistant content counts only tool-call names and arguments', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'one', arguments: '{}' },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'two', arguments: '{"x":1}' },
        },
      ],
    },
  ];
  const shape = requestShape(messages);
  assert.equal(shape.assistantMessages, 1);
  assert.equal(shape.assistantChars, 15);
  assert.equal(shape.inputChars, 15);
});

test('recomputes tools after appends and nested schema mutations', () => {
  const tools = [{ name: 'one', schema: { description: 'a' } }];
  for (let step = 0; step < 3; step++) {
    const shape = requestShape([], tools);
    assert.equal(shape.toolDefs, tools.length);
    assert.equal(shape.toolDefsChars, JSON.stringify(tools).length);
    if (step === 0) tools.push({ name: 'two', schema: { description: 'b' } });
    else tools[0].schema.description += 'changed';
  }
  assert.equal(requestShape([], []).toolDefsChars, 0);
});
