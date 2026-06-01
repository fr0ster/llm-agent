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

test('a consumer systemPrompt override replaces STEPPER_PLANNER_SYSTEM (granularity still appended)', async () => {
  const { obj, calls } = llm(
    '{"objective":"o","nodes":[{"id":"a","goal":"x"}]}',
  );
  const planner = new LlmStepperPlanner(
    obj as never,
    'shallow',
    'CONSUMER PLANNER PROMPT.',
  );
  await planner.plan({
    prompt: 'p',
    knowledgeRag: ragWith([]) as never,
    ...BASE,
  });
  const sysMsg =
    calls[0].messages.find((m) => m.role === 'system')?.content ?? '';
  assert.match(sysMsg, /CONSUMER PLANNER PROMPT\./);
  assert.doesNotMatch(sysMsg, /recursive Stepper hierarchy/); // default gone
  assert.match(sysMsg, /GRANULARITY/); // directive still appended
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

test('STEPPER_PLANNER_SYSTEM instructs planner to use fetch steps and restricts needInfo to non-fetchable data', () => {
  // Must tell planner workers can fetch via tools
  assert.match(
    STEPPER_PLANNER_SYSTEM,
    /fetch.*step|workers can.*fetch|FETCH STEPS/i,
  );
  // Must say needInfo is only for non-fetchable data
  assert.match(
    STEPPER_PLANNER_SYSTEM,
    /ONLY for a fact that NO.*tool|no listed tool/i,
  );
  // Must forbid needInfo for fetchable data
  assert.match(STEPPER_PLANNER_SYSTEM, /NEVER use needInfo for fetchable/i);
});

test('planner embeds toolsRag catalog into the planning prompt', async () => {
  const { obj, calls } = llm(
    '{"objective":"o","nodes":[{"id":"a","goal":"fetch source via get_program_source"}]}',
  );
  const planner = new LlmStepperPlanner(obj as never);

  const toolsRagStub = {
    async query() {
      return [
        {
          name: 'get_program_source',
          description: 'Reads ABAP program source code from SAP',
        },
        {
          name: 'search_objects',
          description: 'Searches for SAP objects by name pattern',
        },
      ];
    },
    lookup() {
      return undefined;
    },
  };

  await planner.plan({
    prompt: 'review ABAP program ZTEST',
    knowledgeRag: ragWith([]) as never,
    toolsRag: toolsRagStub as never,
    parentPath: ['root'],
    identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
  });

  const userMsg =
    calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
  assert.match(
    userMsg,
    /get_program_source/,
    'tool name must appear in prompt',
  );
  assert.match(
    userMsg,
    /search_objects/,
    'second tool name must appear in prompt',
  );
  assert.match(
    userMsg,
    /Available tools/,
    'tools section header must be present',
  );
});

test('planner renders prompt correctly when toolsRag returns empty', async () => {
  const { obj, calls } = llm(
    '{"objective":"o","nodes":[{"id":"a","goal":"x"}]}',
  );
  const planner = new LlmStepperPlanner(obj as never);

  await planner.plan({
    prompt: 'some task',
    knowledgeRag: ragWith([]) as never,
    ...BASE,
  });

  const userMsg =
    calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
  // No tools section when toolsRag returns empty
  assert.doesNotMatch(userMsg, /Available tools/);
  assert.match(userMsg, /some task/);
});

test('planner renders prompt correctly when toolsRag throws', async () => {
  const { obj, calls } = llm(
    '{"objective":"o","nodes":[{"id":"a","goal":"x"}]}',
  );
  const planner = new LlmStepperPlanner(obj as never);

  const throwingToolsRag = {
    async query(): Promise<never> {
      throw new Error('rag unavailable');
    },
    lookup() {
      return undefined;
    },
  };

  await planner.plan({
    prompt: 'some task',
    knowledgeRag: ragWith([]) as never,
    toolsRag: throwingToolsRag as never,
    parentPath: ['root'],
    identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
  });

  const userMsg =
    calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
  // Graceful: no crash, no tools section
  assert.doesNotMatch(userMsg, /Available tools/);
  assert.match(userMsg, /some task/);
});
