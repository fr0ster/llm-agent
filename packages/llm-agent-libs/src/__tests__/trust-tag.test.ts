import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IDecisionModel, ILlm, Message } from '@mcp-abap-adt/llm-agent';
import { toModelToolMessages } from '@mcp-abap-adt/llm-agent';
import { ContextAssembler } from '../context/context-assembler.js';
import { renderPlannerRetrieval } from '../coordinator/dialogue/planner-context-builder.js';
import {
  RagPlannerKnowledge,
  retrievePlannerContext,
} from '../coordinator/dialogue/planner-retrieval.js';
import { DecisionReranker } from '../reranker/decision-reranker.js';
import { LlmReranker } from '../reranker/llm-reranker.js';
import { scanDirsForSkills } from '../skills/skill-utils.js';
import { makeLlm, makeRag } from '../testing/index.js';

test('planner retrieval copies metadata trust and source for knowledge and memory', async () => {
  const embedder = {
    async embedQuery() {
      return { vector: [1] };
    },
    async embedDocument() {
      return { vector: [1] };
    },
  };
  const knowledge = new RagPlannerKnowledge(
    'kb',
    makeRag([
      {
        text: 'fact',
        score: 1,
        metadata: { id: 'r1', trust: 4, source: 'user:kb/r1' },
      },
    ]),
    embedder,
  );
  const context = await retrievePlannerContext(
    {
      plannerKnowledge: [knowledge],
      plannerMemory: {
        queryEmbedder: embedder,
        documentEmbedder: embedder,
        rag: makeRag([
          {
            text: 'memory',
            score: 1,
            metadata: {
              sessionId: 's',
              requestId: 'old',
              sourceId: 's1',
              offset: 0,
              kind: 'planner-input',
              trust: 2,
              source: 'session:s1',
            },
          },
        ]),
      },
    },
    's',
    'new',
    'q',
    false,
    {},
    () => {},
  );
  assert.deepEqual(context.knowledge[0], {
    collection: 'kb',
    id: 'r1',
    text: 'fact',
    trust: 4,
    source: 'user:kb/r1',
  });
  assert.equal(context.memory[0].trust, 2);
  assert.equal(context.memory[0].source, 'session:s1');
  assert.match(
    renderPlannerRetrieval({ ...context, notes: [] }).join(''),
    /\(session:s1; trust 2\) memory/,
  );
});

test('ContextAssembler projects tool history trust without altering stored content', async () => {
  const history = [
    {
      call: { id: 'c', name: 'GetClass', arguments: {} },
      result: { content: 'raw' },
    },
  ];
  const result = await new ContextAssembler({
    toolTrust: () => ({ source: 'system:GetClass', trust: 4.5 }),
  }).assemble(
    { type: 'action', text: 'q' },
    { tools: [], ragResults: {} },
    history,
  );
  assert.ok(result.ok);
  assert.equal(
    result.value.at(-1)?.content,
    '[source: system:GetClass; trust 4.5]\nGetClass: raw',
  );
  assert.equal(history[0].result.content, 'raw');
});

test('rerankers show trust without changing relevance scores or raw passages', async () => {
  const candidates = [
    { text: 'raw', score: 0.1, metadata: { trust: 3, source: 'user:kb/r1' } },
  ];
  const seen: Message[][] = [];
  const base = makeLlm([{ content: '[0.8]' }]);
  const llm: ILlm = {
    ...base,
    async chat(messages, tools, options) {
      seen.push(messages);
      return base.chat(messages, tools, options);
    },
  };
  const first = await new LlmReranker(llm).rerank('q', candidates);
  assert.ok(first.ok);
  assert.equal(first.value[0].score, 0.8);
  assert.match(
    seen[0].map((m) => m.content).join(''),
    /\[source: user:kb\/r1; trust 3\] raw/,
  );
  let passage = '';
  const model: IDecisionModel = {
    async decide(request) {
      const question = request.questions.r0;
      if (
        question.type === 'noul' &&
        typeof question.instructions === 'object' &&
        question.instructions !== null &&
        !Array.isArray(question.instructions)
      )
        passage = String(question.instructions.passage);
      return {
        ok: true,
        value: {
          model: 'fake',
          answers: { r0: { type: 'noul', probability: 0.7 } },
        },
      };
    },
  };
  const second = await new DecisionReranker(model).rerank('q', candidates);
  assert.ok(second.ok);
  assert.equal(second.value[0].score, 0.7);
  assert.equal(passage, '[source: user:kb/r1; trust 3] raw');
  assert.equal(candidates[0].text, 'raw');
});

test('planner labels preserve legacy labels and project trust with source class', () => {
  const entry = { collection: 'kb', id: 'r1', text: 't' };
  assert.match(
    renderPlannerRetrieval({ notes: [], memory: [], knowledge: [entry] }).join(
      '',
    ),
    /\(kb\/r1\) t/,
  );
  assert.match(
    renderPlannerRetrieval({
      notes: [],
      memory: [],
      knowledge: [{ ...entry, source: 'user:kb/r1', trust: 4 }],
    }).join(''),
    /\(user:kb\/r1; trust 4\) t/,
  );
  assert.match(
    renderPlannerRetrieval({
      notes: [],
      memory: [],
      knowledge: [{ ...entry, trust: 4 }],
    }).join(''),
    /\(kb\/r1; trust 4\) t/,
  );
  assert.match(
    renderPlannerRetrieval({
      notes: [],
      memory: [],
      knowledge: [{ ...entry, source: 'ignored' }],
    }).join(''),
    /\(kb\/r1\) t/,
  );
  assert.match(
    renderPlannerRetrieval({
      notes: [],
      knowledge: [],
      memory: [
        {
          kind: 'planner-input',
          sourceId: 's1',
          requestId: 'q1',
          offset: 0,
          text: 'text',
          trust: 2,
        },
      ],
    }).join(''),
    /\(planner-input s1 q1 offset 0; trust 2\) text/,
  );
});

test('ContextAssembler tags numeric trust only and preserves provenance', async () => {
  const result = await new ContextAssembler({
    includeProvenance: true,
  }).assemble(
    { type: 'action', text: 'q' },
    {
      tools: [],
      ragResults: {
        facts: [
          {
            text: 'x',
            metadata: { trust: 3, source: 'user:Notes/r1' },
            score: 0.9,
          },
          { text: 'y', metadata: {}, score: 0.8 },
          { text: 'z', metadata: { trust: '3' }, score: 0.7 },
        ],
      },
    },
    [],
  );
  assert.ok(result.ok);
  const text = result.value.map((m) => m.content).join('\n');
  assert.match(text, /- \[source: user:Notes\/r1; trust 3\] x \[score: 0.90\]/);
  assert.match(text, /- y \[score: 0.80\]/);
  assert.match(text, /- z \[score: 0.70\]/);
});

test('ContextAssembler projects message history before windowing without double tagging', async () => {
  const history: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c', content: 'raw' },
  ];
  const toolTrust = () => ({ source: 'system:Read', trust: 5 });
  for (const historyRecencyWindow of [undefined, 1]) {
    const assembled = await new ContextAssembler({
      toolTrust,
      historyRecencyWindow,
    }).assemble(
      { type: 'action', text: 'q' },
      { tools: [], ragResults: {} },
      history,
    );
    assert.ok(assembled.ok);
    const replay = toModelToolMessages(assembled.value, toolTrust);
    assert.equal(
      replay.find((message) => message.role === 'tool')?.content,
      '[source: system:Read; trust 5]\nraw',
    );
  }
  assert.equal(history[1].content, 'raw');
});

test('skill discovery rejects duplicate names with different kinds before deduplication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trust-skills-'));
  try {
    const dirs = [join(root, 'a'), join(root, 'b')];
    for (const [index, dir] of dirs.entries()) {
      await mkdir(join(dir, 'skill'), { recursive: true });
      await writeFile(
        join(dir, 'skill', 'SKILL.md'),
        `---\nname: duplicate\ndescription: test\nkind: ${index ? 'informational' : 'base'}\n---\nbody`,
      );
    }
    await assert.rejects(scanDirsForSkills(dirs), /duplicate.*kind/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
