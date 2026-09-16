import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpConnectionConfig } from '@mcp-abap-adt/llm-agent';
import { toMcpClientWrapperConfig } from '../factory.js';

test('stdio config carries env through to the wrapper config', () => {
  const config: McpConnectionConfig = {
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: 'per-caller' },
  };

  const wrapper = toMcpClientWrapperConfig(config);

  assert.equal(wrapper.transport, 'stdio');
  assert.deepEqual(wrapper.env, { TOKEN: 'per-caller' });
});

test('an stdio config without env stays without one', () => {
  const wrapper = toMcpClientWrapperConfig({ type: 'stdio', command: 'node' });
  assert.equal('env' in wrapper, false);
});
