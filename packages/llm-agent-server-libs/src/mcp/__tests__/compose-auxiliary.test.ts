import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IAuxiliaryMcpTools,
  IToolsRagHandle,
  LlmTool,
  McpTool,
} from '@mcp-abap-adt/llm-agent';
import { assertNoAuxCollision, resolveAuxDefs } from '../compose-auxiliary.js';

const waitDef: McpTool = { name: 'wait', description: 'w', inputSchema: {} };

const auxOk: IAuxiliaryMcpTools = {
  async listTools() {
    return { ok: true, value: [waitDef] };
  },
  async callTool() {
    return { ok: true, value: { content: 'x' } };
  },
};

const auxFail: IAuxiliaryMcpTools = {
  async listTools() {
    return { ok: false, error: new Error('boom') as never };
  },
  async callTool() {
    return { ok: true, value: { content: 'x' } };
  },
};

const emptyToolsRag: IToolsRagHandle = {
  async query() {
    return [];
  },
  lookup() {
    return undefined;
  },
};

const collidingToolsRag: IToolsRagHandle = {
  async query() {
    return [];
  },
  lookup(name: string): LlmTool | undefined {
    return name === 'wait'
      ? { name: 'wait', description: 'domain', inputSchema: {} }
      : undefined;
  },
};

test('resolveAuxDefs returns defs on ok', async () => {
  assert.deepEqual(
    (await resolveAuxDefs(auxOk)).map((d) => d.name),
    ['wait'],
  );
});

test('resolveAuxDefs throws (never silently skips) on !ok', async () => {
  await assert.rejects(resolveAuxDefs(auxFail), /failed to list/);
});

test('assertNoAuxCollision throws when a domain tool shares the name', () => {
  assert.throws(
    () => assertNoAuxCollision([waitDef], collidingToolsRag),
    /collides with a connected MCP tool/,
  );
});

test('assertNoAuxCollision passes when lookup returns undefined (EMPTY/no-domain)', () => {
  assert.doesNotThrow(() => assertNoAuxCollision([waitDef], emptyToolsRag));
});
