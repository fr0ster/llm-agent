import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PIPELINE_FAILURE_CODES } from '../index.js';
import { MCP_UNAVAILABLE_CODES } from '../types.js';

describe('PIPELINE_FAILURE_CODES (spec §10.5.1, D69)', () => {
  it('holds exactly the three pipeline failure codes', () => {
    assert.deepEqual(PIPELINE_FAILURE_CODES, {
      RAG_STORE_MISSING: 'RAG_STORE_MISSING',
      STATE_CORRUPT: 'STATE_CORRUPT',
      TOOL_ARGUMENTS_JSON_PARSE_FAILED: 'TOOL_ARGUMENTS_JSON_PARSE_FAILED',
    });
  });

  it('widens no shared set — MCP_UNAVAILABLE_CODES is unchanged', () => {
    assert.deepEqual(
      [...MCP_UNAVAILABLE_CODES],
      [
        'MCP_NOT_CONNECTED',
        'MCP_TIMEOUT',
        'MCP_TRANSPORT',
        'MCP_HTTP_403',
        'MCP_HTTP_404',
        'MCP_HTTP_502',
        'MCP_HTTP_503',
        'MCP_NO_RESPONSE',
      ],
    );
  });
});
