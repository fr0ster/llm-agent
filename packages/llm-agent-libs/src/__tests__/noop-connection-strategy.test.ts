import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NoopConnectionStrategy } from '@mcp-abap-adt/llm-agent-mcp';
import { makeMcpClient } from '../testing/index.js';

describe('NoopConnectionStrategy', () => {
  it('returns currentClients unchanged with toolsChanged: false', async () => {
    const strategy = new NoopConnectionStrategy();
    const clients = [makeMcpClient([])];
    const result = await strategy.resolve(clients);
    assert.equal(result.clients, clients);
    assert.equal(result.toolsChanged, false);
  });

  it('returns empty array unchanged', async () => {
    const strategy = new NoopConnectionStrategy();
    const result = await strategy.resolve([]);
    assert.deepEqual(result.clients, []);
    assert.equal(result.toolsChanged, false);
  });
});
