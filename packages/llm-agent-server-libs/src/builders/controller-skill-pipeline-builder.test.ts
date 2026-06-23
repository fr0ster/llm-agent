import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControllerSkillPipelineBuilder } from './controller-skill-pipeline-builder.js';

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
