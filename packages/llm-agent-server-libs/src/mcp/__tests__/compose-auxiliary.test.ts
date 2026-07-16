import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IAuxiliaryMcpTools,
  IToolsRagHandle,
  LlmTool,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  assertNoAuxCollision,
  composeAuxiliaryBridge,
  resolveAuxDefs,
} from '../compose-auxiliary.js';

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

test('composeAuxiliaryBridge: aux name maps ok content to string; domain untouched', async () => {
  let domainCalls = 0;
  const domain = async () => {
    domainCalls++;
    return 'DOMAIN';
  };
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: true,
    value: { content: 'Waited 1s' },
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, domain);
  assert.equal(await bridge('wait', { seconds: 1 }), 'Waited 1s');
  assert.equal(domainCalls, 0);
  assert.equal(await bridge('ReadTable', {}), 'DOMAIN');
  assert.equal(domainCalls, 1);
});

test('composeAuxiliaryBridge: aux ok object content is JSON-stringified', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: true,
    value: { content: { a: 1 } },
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => 'D');
  assert.equal(await bridge('wait', {}), JSON.stringify({ a: 1 }));
});

test('composeAuxiliaryBridge: aux !ok maps to error.message (no throw, no domain)', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: false,
    error: { message: 'bad args' } as McpError,
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => 'D');
  assert.equal(await bridge('wait', {}), 'bad args');
});

test('composeAuxiliaryBridge: an aux rejection (abort) propagates, not mapped', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => {
    throw new DOMException('Aborted', 'AbortError');
  };
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => 'D');
  await assert.rejects(bridge('wait', {}));
});
