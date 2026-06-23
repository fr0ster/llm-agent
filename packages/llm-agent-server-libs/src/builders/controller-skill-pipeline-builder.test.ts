import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkillPluginsConfig } from '../smart-agent/skill-plugins-config.js';
import type { BuildAgentDeps } from '../smart-agent/smart-server.js';
import { ControllerSkillPipelineBuilder } from './controller-skill-pipeline-builder.js';

// build() routes through the real resolveSmartServerConfig, whose config
// validator requires AICORE_SERVICE_KEY for the sap-ai-sdk provider. The DI
// stubs (makeLlm/embedder/buildSkillHost) mean no SAP AI Core connection is
// ever opened, so a dummy value satisfies validation without any I/O.
process.env.AICORE_SERVICE_KEY ??= JSON.stringify({
  clientid: 'test',
  clientsecret: 'test',
  url: 'https://example.invalid',
  serviceurls: { AI_API_URL: 'https://example.invalid' },
});

function stubHost() {
  return {
    rag: () => ({ query: async () => [], activeManifest: async () => ({}) }),
    groups: () => [{ group: 'sap' }],
    load: async () => {},
  } as unknown as import('@mcp-abap-adt/llm-agent').ISkillPluginHost;
}

test('fluent calls translate to the expected SmartServerConfig', () => {
  const cfg = new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk', model: 'anthropic--claude-4.6-sonnet' })
    .withRoleLlm('planner', {
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o',
    })
    .withMcp({ url: 'http://localhost:3001/mcp/stream/http' })
    .withSkillSource({
      github: 'https://github.com/secondsky/sap-skills.git',
      enabled: ['sap-abap', 'sap-btp-developer-guide'],
      collection: 'sap',
    })
    .withEmbedder({ provider: 'sap-ai-core', model: 'text-embedding-3-small' })
    .withBudgets({ maxToolCalls: 30 })
    .toConfig();

  assert.equal(cfg.pipeline?.name, 'controller');
  const sub = (cfg.pipeline?.config as any).subagents;
  assert.equal(sub.evaluator.provider, 'sap-ai-sdk');
  assert.equal(sub.executor.provider, 'sap-ai-sdk');
  assert.equal(sub.planner.provider, 'openai');
  assert.equal(sub.planner.apiKey, 'k');
  assert.equal((cfg.pipeline?.config as any).budgets.maxToolCalls, 30);
  assert.deepEqual(cfg.mcp, [
    { type: 'http', url: 'http://localhost:3001/mcp/stream/http' },
  ]);
  assert.equal((cfg as any).skillPlugins.controllerSkillGroup, 'sap');
  assert.equal(
    (cfg as any).skillPlugins.sources[0].github,
    'https://github.com/secondsky/sap-skills.git',
  );
  assert.equal(
    (cfg as any).skillPlugins.sources[0].strategyConfig.collection,
    'sap',
  );
  assert.equal((cfg as any).rag.embedder, 'sap-ai-core');
});

test('withPlanner(weak-executor) selects the controller-weak pipeline', () => {
  const cfg = new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk' })
    .withSkillSource({ github: 'a/b', enabled: ['x'] })
    .withEmbedder({ provider: 'sap-ai-core' })
    .withPlanner('weak-executor')
    .toConfig();
  assert.equal(cfg.pipeline?.name, 'controller-weak');
});

test('build() throws when no LLM was set', () => {
  assert.throws(
    () =>
      new ControllerSkillPipelineBuilder()
        .withSkillSource({ github: 'a/b', enabled: ['x'] })
        .withEmbedder({ provider: 'sap-ai-core' })
        .toConfig(),
    /withLlm/,
  );
});

test('build() throws when no skill source was set', () => {
  assert.throws(
    () =>
      new ControllerSkillPipelineBuilder()
        .withLlm({ provider: 'sap-ai-sdk' })
        .withEmbedder({ provider: 'sap-ai-core' })
        .toConfig(),
    /withSkillSource/,
  );
});

test('build() throws when no embedder was set (skills need one)', () => {
  assert.throws(
    () =>
      new ControllerSkillPipelineBuilder()
        .withLlm({ provider: 'sap-ai-sdk' })
        .withSkillSource({ github: 'a/b', enabled: ['x'] })
        .toConfig(),
    /withEmbedder/,
  );
});

test('build(deps): normalized skill config reaches buildSkillHost (P1a), injected embedder covers all paths (P1b), no I/O', async () => {
  const cannedLlm = {
    chat: async () => ({ ok: true, value: { content: '', toolCalls: [] } }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const stubEmbedder = {
    embed: async () => ({ vector: [0, 0, 0] }),
  } as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;
  let skillCfgSeen: SkillPluginsConfig | undefined;
  const deps: BuildAgentDeps = {
    makeLlm: async () => cannedLlm,
    embedder: stubEmbedder,
    buildSkillHost: async (cfg) => {
      skillCfgSeen = cfg;
      return stubHost();
    },
    connectMcp: async () => [],
    prefetchEmbedderFactories: async () => {
      throw new Error('prefetch must not run when deps.embedder is injected');
    },
  };
  const { agent, close } = await new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk', model: 'anthropic--claude-4.6-sonnet' })
    .withSkillSource({
      github: 'secondsky/sap-skills',
      enabled: ['sap-abap'],
      collection: 'sap',
    })
    .withEmbedder({ provider: 'sap-ai-core', model: 'text-embedding-3-small' })
    .build(deps);
  assert.equal(typeof agent.process, 'function');
  assert.ok(skillCfgSeen, 'buildSkillHost was called');
  assert.equal(skillCfgSeen!.store.type, 'in-memory');
  assert.ok(skillCfgSeen!.catalog, 'catalog default present');
  assert.notEqual(skillCfgSeen!.chunk, undefined);
  await close();
});

test('build(deps) with a prebuilt skillHost still routes through load/validate (P2)', async () => {
  const cannedLlm = {
    chat: async () => ({ ok: true, value: { content: '', toolCalls: [] } }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  let loaded = false;
  const host = {
    ...stubHost(),
    load: async () => {
      loaded = true;
    },
  } as unknown as import('@mcp-abap-adt/llm-agent').ISkillPluginHost;
  const { close } = await new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'sap-ai-sdk', model: 'anthropic--claude-4.6-sonnet' })
    .withSkillSource({
      github: 'a/b',
      enabled: ['sap-abap'],
      collection: 'sap',
    })
    .withEmbedder({ provider: 'sap-ai-core', model: 'text-embedding-3-small' })
    .build({
      makeLlm: async () => cannedLlm,
      // biome-ignore lint/suspicious/noExplicitAny: stub embedder for test
      embedder: { embed: async () => ({ vector: [0] }) } as any,
      skillHost: host,
      connectMcp: async () => [],
    });
  assert.equal(
    loaded,
    true,
    'prebuilt host still went through initSkillHost.load()',
  );
  await close();
});
