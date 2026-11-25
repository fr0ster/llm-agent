import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ILlm,
  type ISkill,
  type ISkillManager,
  SKILL_RETRIEVAL_INVALID,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../builder.js';
import { unwrapBuilderResult } from '../../builder-types.js';
import {
  makeClassifier,
  makeLlm,
  makeMcpClient,
  makeRag,
  ownedTestStores,
  testCallOptions,
  testRequestAccess,
} from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';
import { LlmSkillRetriever } from '../skill-retrieval/llm-skill-retriever.js';
import { LlmToolRetriever } from '../tool-retrieval/llm-tool-retriever.js';

const text = 'Read and review the record';
const tools = [{ name: 'read', description: 'Read a record', inputSchema: {} }];

function skillManager(
  onLoad: (name: string) => void = () => {},
): ISkillManager {
  const skills = ['write', 'review'].map<ISkill>((name) => {
    const description = `How to ${name}`;
    return {
      name,
      description,
      meta: { name, description },
      async getContent() {
        onLoad(name);
        return { ok: true, value: `Instructions for ${name}` };
      },
      async listResources() {
        return { ok: true, value: [] };
      },
      async readResource() {
        return { ok: true, value: '' };
      },
    };
  });
  return {
    async listSkills() {
      return { ok: true, value: skills };
    },
    async getSkill(name) {
      return { ok: true, value: skills.find((skill) => skill.name === name) };
    },
    async matchSkills() {
      return { ok: true, value: [] };
    },
  };
}

test('one selector model selects tools and skills without catalogue RAG while history and knowledge still query', async (t) => {
  const toolsRag = makeRag();
  const skillsRag = makeRag();
  const historyRag = makeRag();
  const knowledgeRag = makeRag();
  const loaded: string[] = [];
  const selection = makeLlm([
    { content: '{"skills":["review"]}', finishReason: 'stop' },
    { content: '{"tools":["read"]}', finishReason: 'stop' },
  ]);
  const selectorChat = t.mock.method(selection, 'chat');
  const main = makeLlm([
    {
      content: '',
      toolCalls: [{ name: 'read', id: 'read1', arguments: {} }],
      finishReason: 'tool_calls',
    },
    { content: 'Reviewed', finishReason: 'stop' },
  ]);
  const mainChat = t.mock.method(main, 'streamChat');
  const mcp = makeMcpClient(tools);
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm(main)
    .withClassifier(makeClassifier([{ type: 'action', text }]))
    .withMcpClients([mcp])
    .setToolsRag(toolsRag)
    .setHistoryRag(historyRag)
    .addRagCollection({
      name: 'skills',
      rag: skillsRag,
      meta: { displayName: 'Skill catalogue', scope: 'global' },
    })
    .addRagCollection({
      name: 'knowledge',
      rag: knowledgeRag,
      meta: { displayName: 'Knowledge', scope: 'global' },
    })
    .withSkillManager(
      skillManager((name) => loaded.push(name)),
      { vectorize: false },
    )
    .withToolReselection(true)
    .withToolRetriever(new LlmToolRetriever(selection))
    .withSkillRetriever(new LlmSkillRetriever(selection))
    .withSkippedRagStores('tools', 'skills')
    .build()
    .then(unwrapBuilderResult);
  try {
    const result = await handle.agent.process(text, testCallOptions());
    assert.equal(result.ok, true);
    assert.equal(toolsRag.queryCount, 0);
    assert.equal(skillsRag.queryCount, 0);
    assert.equal(historyRag.queryCount, 1);
    assert.equal(knowledgeRag.queryCount, 1);
    assert.deepEqual(loaded, ['review']);
    assert.equal(mcp.callCount, 1);
    assert.equal(selectorChat.mock.callCount(), 2);
    const [skillPrompt, toolPrompt] = selectorChat.mock.calls.map(
      ({ arguments: [messages] }) => messages,
    );
    assert.equal(
      skillPrompt[1].content,
      'Skill catalogue:\n[{"name":"review","description":"How to review"},{"name":"write","description":"How to write"}]',
    );
    assert.match(toolPrompt[1].content ?? '', /^Tool catalogue:/);
    assert.equal(skillPrompt.at(-1)?.content, text);
    assert.equal(toolPrompt.at(-1)?.content, text);
    const [messages, offered] = mainChat.mock.calls[0].arguments;
    assert.deepEqual(
      offered?.map(({ name }) => name),
      ['read'],
    );
    assert.ok(
      messages.some(({ content }) =>
        content?.includes('Instructions for review'),
      ),
    );
  } finally {
    await handle.close();
  }
});

test('skipped RAG stores stay out of the default selectors’ fallback searches', async () => {
  const toolsRag = makeRag();
  const skillsRag = makeRag();
  const historyRag = makeRag();
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    mainLlm: makeLlm([{ content: 'Reviewed', finishReason: 'stop' }]),
    classifier: makeClassifier([{ type: 'action', text }]),
    mcpClients: [makeMcpClient(tools)],
    skillManager: skillManager(),
    ragAccess: testRequestAccess,
    toolsRag,
    historyRag,
    ragStores: ownedTestStores({ skills: skillsRag }),
    skippedRagStores: ['tools', 'skills'],
  });
  const result = await pipeline.execute(text, [], testCallOptions(), () => {});
  assert.equal(result.error, undefined);
  assert.equal(toolsRag.queryCount, 0);
  assert.equal(skillsRag.queryCount, 0);
  // Generic history retrieval and both default selectors search the eligible store.
  assert.equal(historyRag.queryCount, 3);
});

test('an invalid LLM skill selection ends the pipeline with usage and without a RAG retry', async () => {
  const rag = makeRag();
  const main = makeLlm([]);
  const selector: ILlm = {
    ...makeLlm([
      {
        content: '{"skills":["absent"]}',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      },
    ]),
    model: 'selector',
  };
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    mainLlm: main,
    classifier: makeClassifier([{ type: 'action', text }]),
    mcpClients: [],
    ragAccess: testRequestAccess,
    toolsRag: rag,
    skippedRagStores: ['tools'],
    skillManager: skillManager(),
    skillRetriever: new LlmSkillRetriever(selector),
  });
  const result = await pipeline.execute(text, [], testCallOptions(), () => {});
  assert.equal(result.error?.code, SKILL_RETRIEVAL_INVALID);
  assert.equal(result.error?.usageCalls?.[0].totalTokens, 7);
  assert.equal(main.callCount, 0);
  assert.equal(rag.queryCount, 0);
});
