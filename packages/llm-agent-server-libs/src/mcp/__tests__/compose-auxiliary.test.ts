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
  composeAuxiliarySelect,
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
    return { text: 'DOMAIN', isError: false };
  };
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: true,
    value: { content: 'Waited 1s' },
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, domain);
  assert.equal((await bridge('wait', { seconds: 1 })).text, 'Waited 1s');
  assert.equal(domainCalls, 0);
  assert.equal((await bridge('ReadTable', {})).text, 'DOMAIN');
  assert.equal(domainCalls, 1);
});

test('composeAuxiliaryBridge: aux ok object content is JSON-stringified', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: true,
    value: { content: { a: 1 } },
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => ({
    text: 'D',
    isError: false,
  }));
  assert.equal((await bridge('wait', {})).text, JSON.stringify({ a: 1 }));
});

test('composeAuxiliaryBridge: aux !ok maps to error.message (no throw, no domain)', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => ({
    ok: false,
    error: { message: 'bad args' } as McpError,
  });
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => ({
    text: 'D',
    isError: false,
  }));
  assert.deepEqual(await bridge('wait', {}), {
    text: 'bad args',
    isError: true,
  });
});

test('composeAuxiliaryBridge: an aux rejection (abort) propagates, not mapped', async () => {
  const auxCall = async (): Promise<Result<McpToolResult, McpError>> => {
    throw new DOMException('Aborted', 'AbortError');
  };
  const bridge = composeAuxiliaryBridge([waitDef], auxCall, async () => ({
    text: 'D',
    isError: false,
  }));
  await assert.rejects(bridge('wait', {}));
});

test('composeAuxiliarySelect merges aux defs into domain results (deduped)', async () => {
  const domain = async () => [
    { name: 'ReadTable', description: 'r', inputSchema: {} },
  ];
  const select = composeAuxiliarySelect([waitDef], domain);
  const out = await select('do something', 5);
  assert.deepEqual(
    out.map((t) => t.name),
    ['ReadTable', 'wait'],
  );
});

test('composeAuxiliarySelect: empty domain (MCP-less) yields exactly the aux defs', async () => {
  const select = composeAuxiliarySelect([waitDef], async () => []);
  const out = await select('x');
  assert.deepEqual(
    out.map((t) => t.name),
    ['wait'],
  );
});

test('composeAuxiliarySelect dedupes if a domain tool already has the aux name', async () => {
  const domain = async () => [
    { name: 'wait', description: 'domain', inputSchema: {} },
  ];
  const select = composeAuxiliarySelect([waitDef], domain);
  const out = await select('x');
  assert.equal(out.filter((t) => t.name === 'wait').length, 1);
});

test('wrappers do not call aux.listTools at runtime (cached defs)', async () => {
  // resolveAuxDefs is the ONLY listTools caller; the wrappers take auxDefs.
  // Guard: build both wrappers from a defs array and exercise them; a spy aux
  // whose listTools throws must never be invoked.
  const spyAux: import('@mcp-abap-adt/llm-agent').IAuxiliaryMcpTools = {
    async listTools() {
      throw new Error('listTools must not be called at runtime');
    },
    async callTool() {
      return { ok: true, value: { content: 'W' } };
    },
  };
  const select = composeAuxiliarySelect([waitDef], async () => []);
  const bridge = composeAuxiliaryBridge(
    [waitDef],
    spyAux.callTool.bind(spyAux),
    async () => 'D',
  );
  await select('x');
  await select('y');
  assert.equal((await bridge('wait', {})).text, 'W');
});
