import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { DefaultMcpFailureClassifier } from '../default-mcp-failure-classifier.js';

const mkErr = (code: string) => new McpError('test error', code);

describe('DefaultMcpFailureClassifier', () => {
  it('classifies MCP_NOT_CONNECTED as unavailable', async () => {
    const result = await new DefaultMcpFailureClassifier().classify(
      mkErr('MCP_NOT_CONNECTED'),
    );
    assert.equal(result, 'unavailable');
  });

  it('classifies MCP_ERROR as tool-error', async () => {
    const result = await new DefaultMcpFailureClassifier().classify(
      mkErr('MCP_ERROR'),
    );
    assert.equal(result, 'tool-error');
  });

  it('classifies MCP_HTTP_404 as unavailable (transport HTTP error)', async () => {
    const result = await new DefaultMcpFailureClassifier().classify(
      mkErr('MCP_HTTP_404'),
    );
    assert.equal(result, 'unavailable');
  });

  it('ignores probeHealth — default is error-based only', async () => {
    // probeHealth resolves false but error is MCP_ERROR (tool-error category)
    // default must still return tool-error without calling probeHealth
    let probeCalled = false;
    const probeHealth = async () => {
      probeCalled = true;
      return false;
    };
    const result = await new DefaultMcpFailureClassifier().classify(
      mkErr('MCP_ERROR'),
      probeHealth,
    );
    assert.equal(result, 'tool-error');
    assert.equal(
      probeCalled,
      false,
      'default classifier must NOT call probeHealth',
    );
  });
});
