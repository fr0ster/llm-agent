import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError, MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from '../adapter.js';
import { MCPClientWrapper } from '../client.js';

const call = { id: '1', name: 'enrich', arguments: {} };
const overflow = new McpError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
const wrap = () => new Error('Enricher wrapper', { cause: overflow });

test('embedded wrapper rethrows context overflow from a plain Error cause', async () => {
  const wrapper = new MCPClientWrapper({
    transport: 'embedded',
    async callToolHandler() {
      throw wrap();
    },
  });
  await assert.rejects(wrapper.callTool(call), (error) => error === overflow);
});

test('MCP adapter preserves wrapped overflow thrown by the client', async () => {
  const wrapper = new MCPClientWrapper({ transport: 'embedded' });
  wrapper.callTool = async () => {
    throw wrap();
  };
  const result = await new McpClientAdapter(wrapper).callTool(call.name, {});
  assert.ok(!result.ok);
  assert.equal(result.error, overflow);
});

for (const afterRetry of [false, true]) {
  test(`remote wrapper stops on overflow ${afterRetry ? 'during reconnect' : 'before reconnect'}`, async () => {
    const wrapper = new MCPClientWrapper({
      transport: 'stream-http',
      url: 'http://localhost:9',
    });
    let connects = 0;
    wrapper.connect = async () => {
      connects++;
      if (afterRetry && connects === 1)
        throw new Error('Connection interrupted');
      throw wrap();
    };
    await assert.rejects(wrapper.callTool(call), (error) => error === overflow);
    assert.equal(connects, afterRetry ? 2 : 1);
  });
}

test('listTools adapter preserves wrapped context overflow', async () => {
  const wrapper = new MCPClientWrapper({ transport: 'embedded' });
  wrapper.listTools = async () => {
    throw wrap();
  };
  const result = await new McpClientAdapter(wrapper).listTools();
  assert.deepEqual(result, { ok: false, error: overflow });
});

test('remote listTools rethrows a wrapped overflow without reconnecting', async () => {
  const wrapper = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9',
  });
  let connects = 0;
  wrapper.connect = async () => {
    connects++;
    throw wrap();
  };
  await assert.rejects(wrapper.listTools(), (error) => error === overflow);
  assert.equal(connects, 1);
});
