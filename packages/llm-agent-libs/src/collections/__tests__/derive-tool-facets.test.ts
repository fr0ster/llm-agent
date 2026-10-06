import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  firstClause,
  nameWords,
  valueWords,
} from '../tools/derive-tool-facets.js';

describe('nameWords — several naming styles, none privileged', () => {
  const table: Array<[string, string]> = [
    ['read_file', 'read file'],
    ['listPullRequests', 'list pull requests'],
    ['search-issues', 'search issues'],
    ['db.query', 'db query'],
    ['v2Fetch', 'v 2 fetch'],
    ['fetch', 'fetch'],
    ['', ''],
    ['__', ''],
    ['HTTPServer', 'http server'],
    // labelled mcp-abap-adt examples
    ['GetWhereUsed', 'get where used'],
    ['GetATCFindings', 'get atc findings'],
    ['RuntimeListFeeds', 'runtime list feeds'],
  ];
  for (const [input, want] of table) {
    it(`${input} → ${want}`, () => assert.equal(nameWords(input), want));
  }
  it('value words use the same split', () => {
    assert.equal(valueWords('BEHAVIOR_DEFINITION'), 'behavior definition');
  });
});

describe('firstClause', () => {
  it('up to the first . ; : or newline', () => {
    assert.equal(firstClause('Read a file. Returns its text'), 'Read a file');
    assert.equal(firstClause('List items; paged'), 'List items');
    assert.equal(firstClause('Search: by text'), 'Search');
    assert.equal(firstClause('Line one\nLine two'), 'Line one');
  });
  it('drops a leading bracketed tag (example: mcp-abap-adt [read-only])', () => {
    assert.equal(
      firstClause('[read-only] Retrieve contents of a table. Returns rows'),
      'Retrieve contents of a table',
    );
  });
  it('empty or tag-only description → empty', () => {
    assert.equal(firstClause(''), '');
    assert.equal(firstClause('[read-only]'), '');
  });
  it('at most 200 characters', () => {
    assert.equal(firstClause('x'.repeat(300)).length, 200);
  });
});
