import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import {
  fixedCallerResolver,
  testRagAccess,
} from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { ControllerSkillPipelineBuilder } from '../../builders/controller-skill-pipeline-builder.js';
import { constructionSeams } from './construction-seams.js';
import { testBuildAgent } from './rag-identity-fixture.js';

function client(): IMcpClient {
  return {
    async listTools() {
      return { ok: true, value: [] };
    },
    async callTool() {
      return { ok: true, value: { content: [] } };
    },
  };
}

const config = { llm: { model: 'test-model' }, skipModelValidation: true };
const migrationMessage =
  /Multiple MCP clients require a descriptor label.*withMcpServers\(\).*named mcp: entries/;

test('SmartServer rejects multiple ready clients at build time', async () => {
  await assert.rejects(
    () =>
      testBuildAgent(config, {
        ...constructionSeams,
        mcpClients: [client(), client()],
      }),
    migrationMessage,
  );
});

test('SmartServer preserves labels when passing connected clients into its builder', async () => {
  const handle = await testBuildAgent(
    {
      ...config,
      mcp: [
        { type: 'http', name: 'first', url: 'http://localhost/first' },
        { type: 'http', name: 'second', url: 'http://localhost/second' },
      ],
    },
    {
      ...constructionSeams,
      connectMcpWithDescriptors: async () => ({
        clients: [client(), client()],
        clientDescriptors: [
          { slotIndex: 0, label: 'first' },
          { slotIndex: 1, label: 'second' },
        ],
        configuredSlotCount: 2,
      }),
    },
  );
  await handle.close();
});

test('SmartServer rejects mixed labels before filtering failed listTools calls', async () => {
  let lists = 0;
  const unavailable: IMcpClient = {
    ...client(),
    async listTools() {
      lists++;
      throw new Error('unavailable');
    },
  };
  await assert.rejects(
    () =>
      testBuildAgent(config, {
        ...constructionSeams,
        connectMcpWithDescriptors: async () => ({
          clients: [client(), unavailable],
          clientDescriptors: [
            { slotIndex: 0, label: 'first' },
            { slotIndex: 1 },
          ],
          configuredSlotCount: 2,
        }),
      }),
    migrationMessage,
  );
  assert.equal(lists, 0);
});

test('ControllerSkillPipelineBuilder rejects multiple ready clients during build', async () => {
  const builder = new ControllerSkillPipelineBuilder()
    .withRagAccess({
      callerResolver: fixedCallerResolver({
        userId: 'test-user',
        isAdmin: false,
      }),
      ragAccess: testRagAccess(),
    })
    .withLlm({ provider: 'ollama', model: 'test-model' })
    .withSkillSource({ github: 'example/skills', enabled: ['test'] })
    .withEmbedder({ provider: 'ollama', model: 'test-embedder' })
    .withMcpClients([client(), client()]);
  await assert.rejects(
    () =>
      builder.build({
        ...constructionSeams,
        embedder: { embed: async () => ({ vector: [1] }) },
        skillHost: {
          load: async () => ({
            ok: true,
            committed: ['sap'],
            omitted: [],
            tombstoned: [],
          }),
          groups: () => [
            { group: 'sap', description: 'Test skills', collection: 'sap' },
          ],
          rag: () => ({
            query: async () => [],
            activeManifest: async () => null,
          }),
        },
      }),
    migrationMessage,
  );
});

test('ControllerSkillPipelineBuilder carries names for multiple configured servers', () => {
  const cfg = new ControllerSkillPipelineBuilder()
    .withLlm({ provider: 'ollama', model: 'test-model' })
    .withSkillSource({ github: 'example/skills', enabled: ['test'] })
    .withEmbedder({ provider: 'ollama', model: 'test-embedder' })
    .withMcp({ url: 'http://localhost/first', name: 'first' })
    .withMcp({ url: 'http://localhost/second', name: 'second' })
    .toConfig();
  assert.deepEqual(cfg.mcp, [
    { type: 'http', url: 'http://localhost/first', name: 'first' },
    { type: 'http', url: 'http://localhost/second', name: 'second' },
  ]);
});
