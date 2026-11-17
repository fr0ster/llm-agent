import assert from 'node:assert/strict';
import type { Message } from '@mcp-abap-adt/llm-agent';

/** Compare independent runs while preserving the complete call/result graph. */
export function normalizeRoundIds<T>(value: T): T {
  const rounds = new Map<string, number>();
  return JSON.parse(
    JSON.stringify(value).replace(
      /(?:tc|ext):([0-9a-f-]{36}):\d+/g,
      (id: string, uuid: string) => {
        if (!rounds.has(uuid)) rounds.set(uuid, rounds.size);
        return id.replace(uuid, `round-${rounds.get(uuid)}`);
      },
    ),
  ) as T;
}

/** Every recorded call and result occurs once, in the same order. */
export function assertUniqueToolHistory(messages: readonly Message[]): void {
  const calls = messages.flatMap((message) => message.tool_calls ?? []);
  const ids = calls.map((call) => call.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^(?:tc|ext):[0-9a-f-]{36}:\d+$/);
  assert.deepEqual(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id),
    ids,
  );
}
