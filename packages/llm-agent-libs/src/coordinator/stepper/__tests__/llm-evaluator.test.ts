import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EVALUATOR_SYSTEM,
  LlmEvaluator,
  parseVerdict,
} from '../llm-evaluator.js';

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

function ragWith(entries: { content: string; artifactType: string }[]) {
  return {
    async query() {
      return entries.map((e) => ({
        content: e.content,
        metadata: {
          traceId: 't',
          turnId: 'u',
          stepperId: 'n',
          task: 'x',
          artifactType: e.artifactType,
          createdAt: '2026-06-01T00:00:00Z',
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

const toolsRag = (tools: { name: string; description?: string }[]) => ({
  async query() {
    return tools;
  },
  lookup() {
    return undefined;
  },
});

const BASE = {
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
};

test('returns the parsed verdict and embeds RAG facts + tools into the prompt', async () => {
  const { obj, calls } = llm(
    '{"route":"needs-work","missing":["the include bodies"],"reason":"only the shell is present"}',
  );
  const ev = new LlmEvaluator(obj as never);
  const verdict = await ev.evaluate({
    prompt: 'review program Z',
    knowledgeRag: ragWith([
      { content: 'REPORT z. (main shell only)', artifactType: 'mcp-result' },
    ]) as never,
    toolsRag: toolsRag([
      { name: 'GetInclude', description: 'reads an include body' },
    ]) as never,
    ...BASE,
  });
  assert.equal(verdict.route, 'needs-work');
  assert.deepEqual(verdict.missing, ['the include bodies']);
  const user = calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
  assert.match(user, /main shell only/); // known fact present
  assert.match(user, /GetInclude/); // obtainable tool present
});

test('executable verdict carries empty missing', async () => {
  const { obj } = llm(
    '{"route":"executable","missing":[],"reason":"all present"}',
  );
  const ev = new LlmEvaluator(obj as never);
  const v = await ev.evaluate({
    prompt: 'p',
    knowledgeRag: ragWith([]) as never,
    toolsRag: toolsRag([]) as never,
    ...BASE,
  });
  assert.equal(v.route, 'executable');
  assert.deepEqual(v.missing, []);
});

test('needs-consumer verdict carries the questions', async () => {
  const { obj } = llm(
    '{"route":"needs-consumer","missing":["which target client?"],"reason":"human decision"}',
  );
  const ev = new LlmEvaluator(obj as never);
  const v = await ev.evaluate({
    prompt: 'p',
    knowledgeRag: ragWith([]) as never,
    toolsRag: toolsRag([]) as never,
    ...BASE,
  });
  assert.equal(v.route, 'needs-consumer');
  assert.deepEqual(v.missing, ['which target client?']);
});

test('a consumer systemPrompt override replaces EVALUATOR_SYSTEM', async () => {
  const { obj, calls } = llm('{"route":"executable","missing":[]}');
  const ev = new LlmEvaluator(obj as never, 'CONSUMER EVAL PROMPT.');
  await ev.evaluate({
    prompt: 'p',
    knowledgeRag: ragWith([]) as never,
    toolsRag: toolsRag([]) as never,
    ...BASE,
  });
  const sys = calls[0].messages.find((m) => m.role === 'system')?.content ?? '';
  assert.equal(sys, 'CONSUMER EVAL PROMPT.');
});

test('parseVerdict tolerates code fences and prose', () => {
  const v = parseVerdict(
    'Here is my assessment:\n```json\n{"route":"executable","missing":[]}\n```\nDone.',
  );
  assert.equal(v.route, 'executable');
});

test('parseVerdict defaults to needs-work on garbage (never silently executable)', () => {
  assert.equal(parseVerdict('not json at all').route, 'needs-work');
  assert.equal(parseVerdict('{"route":"banana"}').route, 'needs-work');
});

test('EVALUATOR_SYSTEM is task-agnostic (no tool/domain names) and names the 3 routes', () => {
  assert.match(EVALUATOR_SYSTEM, /executable/);
  assert.match(EVALUATOR_SYSTEM, /needs-work/);
  assert.match(EVALUATOR_SYSTEM, /needs-consumer/);
  assert.doesNotMatch(
    EVALUATOR_SYSTEM,
    /\b(ABAP|GetInclude|GetProgram)\b/,
    'must not bind to a domain or tool name',
  );
});
