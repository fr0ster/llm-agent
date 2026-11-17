import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Message } from '@mcp-abap-adt/llm-agent';
import {
  ControllerControlHistory,
  type ControlMessageAnchor,
} from '../control-history.js';

const prefix: Message = { role: 'system', content: 'Instructions' };
const result: Message = {
  role: 'tool',
  content: 'Repeated',
  tool_call_id: 'same',
};
const correction: Message = { role: 'user', content: 'RETRY_SENTINEL' };
const newer: Message = { role: 'assistant', content: 'NEWER_SENTINEL' };

it('anchors corrections after repeated predecessors through a JSON round trip', () => {
  const messages: Message[] = [];
  const anchors: Array<ControlMessageAnchor | null> = [];
  const history = new ControllerControlHistory(messages, anchors, 1);
  history.append([prefix, result, result], correction);
  history.record([result]);
  const persisted = JSON.parse(JSON.stringify({ messages, anchors })) as {
    messages: Message[];
    anchors: Array<ControlMessageAnchor | null>;
  };
  assert.deepEqual(
    new ControllerControlHistory(
      persisted.messages,
      persisted.anchors,
      1,
    ).restore(structuredClone([prefix, result, result, result, newer])),
    [prefix, result, result, correction, result, newer],
  );
});

it('does not mistake a newer identical tool result for an evicted predecessor', () => {
  const messages: Message[] = [];
  const anchors: Array<ControlMessageAnchor | null> = [];
  const history = new ControllerControlHistory(messages, anchors, 1);
  history.append([prefix, result], correction);
  history.record([result]);
  assert.deepEqual(history.restore([prefix, result]), [
    prefix,
    correction,
    result,
  ]);
});

it('retains correction order before newer rounds when a strategy omits predecessors', () => {
  const messages: Message[] = [];
  const anchors: Array<ControlMessageAnchor | null> = [];
  const history = new ControllerControlHistory(messages, anchors, 1);
  history.append([prefix, result], correction);
  const second: Message = { role: 'user', content: 'SECOND_RETRY_SENTINEL' };
  history.append([prefix, result, correction], second);
  assert.deepEqual(history.restore([prefix, newer]), [
    prefix,
    correction,
    second,
    newer,
  ]);
});
