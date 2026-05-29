import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LlmStepperPlanner,
  STEPPER_PLANNER_SYSTEM,
} from '../llm-stepper-planner.js';

function llm(content: string) {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  return {
    obj: {
      name: 'stub',
      async chat(messages: { role: string; content: string }[]) {
        calls.push({ messages });
        return { ok: true as const, value: { content } };
      },
    },
    calls,
  };
}

function ragWith(entries: { content: string; task: string }[]) {
  return {
    async query() {
      return entries.map((e) => ({
        content: e.content,
        metadata: {
          traceId: 't',
          turnId: 'u',
          stepperId: 'n',
          task: e.task,
          artifactType: 'x',
          createdAt: '2026-05-29T00:00:00Z',
        },
      }));
    },
    async list() {
      return [];
    },
    async write() {},
    fingerprint() {
      return 'n=0';
    },
  };
}

const BASE = {
  toolsRag: {
    async query() {
      return [];
    },
    lookup() {
      return undefined;
    },
  },
  parentPath: ['root'],
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
};

test('planner queries knowledge-RAG and embeds retrieved facts into the planning prompt', async () => {
  const { obj, calls } = llm(
    '{"objective":"o","nodes":[{"id":"a","goal":"scan source"}]}',
  );
  const planner = new LlmStepperPlanner(obj as never);
  await planner.plan({
    prompt: 'review security',
    knowledgeRag: ragWith([
      { content: 'REPORT z.', task: 'fetch source' },
    ]) as never,
    ...BASE,
  });
  const userMsg =
    calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
  assert.match(userMsg, /REPORT z\./); // retrieved fact present in prompt
  assert.match(userMsg, /review security/); // task present
});

test('planner parses a shallow plan', async () => {
  const { obj } = llm(
    '{"objective":"o","nodes":[{"id":"a","goal":"x","agent":"w"}]}',
  );
  const planner = new LlmStepperPlanner(obj as never);
  const plan = await planner.plan({
    prompt: 'p',
    knowledgeRag: ragWith([]) as never,
    ...BASE,
  });
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].agent, 'w');
});

test('STEPPER_PLANNER_SYSTEM mandates RAG-first + concrete-leaf decomposition', () => {
  assert.match(
    STEPPER_PLANNER_SYSTEM,
    /already in the knowledge|RAG-first|do not re-?fetch/i,
  );
  assert.match(STEPPER_PLANNER_SYSTEM, /one (?:tool call|step)|concrete leaf/i);
});
