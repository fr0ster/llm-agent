import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mcpContentToText } from '../mcp-content.js';

/**
 * #267 — the MCP bridges used to `JSON.stringify` the canonical text-content
 * envelope, so the executor and any surfaced error saw
 * `[{"type":"text","text":"…"}]` instead of the text. mcpContentToText unwraps a
 * PURE text-block array and leaves everything else stringified (unchanged).
 */
describe('#267 mcpContentToText', () => {
  it('returns a bare string unchanged', () => {
    assert.equal(
      mcpContentToText('Class ZZ_QX9B7 not found'),
      'Class ZZ_QX9B7 not found',
    );
  });

  it('unwraps a single text block (the reported #267 case)', () => {
    const content = [
      {
        type: 'text',
        text: 'MCP error -32603: Error: Failed to read class: Class ZZ_QX9B7 not found',
      },
    ];
    assert.equal(
      mcpContentToText(content),
      'MCP error -32603: Error: Failed to read class: Class ZZ_QX9B7 not found',
    );
  });

  it('joins multiple text blocks with newlines', () => {
    const content = [
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ];
    assert.equal(mcpContentToText(content), 'line 1\nline 2');
  });

  it('stringifies a structured (non-array) payload, unchanged', () => {
    const content = { rows: [{ id: 1 }], count: 1 };
    assert.equal(mcpContentToText(content), JSON.stringify(content));
  });

  it('stringifies a MIXED array (text + non-text) so no block is dropped', () => {
    const content = [
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ];
    assert.equal(mcpContentToText(content), JSON.stringify(content));
  });

  it('stringifies an array with no text blocks, unchanged', () => {
    const content = [{ type: 'resource', resource: { uri: 'x://y' } }];
    assert.equal(mcpContentToText(content), JSON.stringify(content));
  });

  it('stringifies an empty array (not a text envelope)', () => {
    assert.equal(mcpContentToText([]), '[]');
  });

  it('ignores a malformed block (missing text) and stringifies', () => {
    const content = [{ type: 'text' }];
    assert.equal(mcpContentToText(content), JSON.stringify(content));
  });
});
