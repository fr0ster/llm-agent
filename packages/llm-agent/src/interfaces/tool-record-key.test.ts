import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultToolRecordKey, toolNameFromRecord } from './tool-record-key.js';

describe('defaultToolRecordKey', () => {
  it('keeps tool:${name} for a single server', () => {
    assert.equal(
      defaultToolRecordKey.key({
        toolName: 'Search',
        clientIndex: 0,
        clientCount: 1,
      }),
      'tool:Search',
    );
  });

  it('disambiguates by client index for several servers', () => {
    assert.equal(
      defaultToolRecordKey.key({
        toolName: 'Search',
        clientIndex: 1,
        clientCount: 2,
      }),
      'tool:1:Search',
    );
  });
});

describe('toolNameFromRecord', () => {
  it('reads the stored name regardless of the id scheme after tool:', () => {
    // A custom key must keep the `tool:` prefix (so retrieval separates tools
    // from skills); everything after it is free, and the name comes from
    // metadata, not the id.
    assert.equal(
      toolNameFromRecord({ id: 'tool:server1/opaque', name: 'Search' }),
      'Search',
    );
  });

  it('falls back to parsing a single-server id', () => {
    assert.equal(toolNameFromRecord({ id: 'tool:Search' }), 'Search');
  });

  it('falls back to parsing a multi-server id — NOT the client index', () => {
    // The bug this fix exists for: `tool:0:Search` must decode to Search,
    // not "0", or catalog.get() misses and tool selection drops to fallback.
    assert.equal(toolNameFromRecord({ id: 'tool:0:Search' }), 'Search');
    assert.equal(
      toolNameFromRecord({ id: 'tool:12:GetTableContents' }),
      'GetTableContents',
    );
  });

  it('keeps the legacy tool:<name>:<suffix> form — name first', () => {
    // A non-numeric first segment is a name, not a client index, so the suffix
    // is dropped as before. Guards the historical `tool:B:hash` shape.
    assert.equal(toolNameFromRecord({ id: 'tool:B:hash' }), 'B');
  });

  it('returns undefined for a non-tool record', () => {
    assert.equal(toolNameFromRecord({ id: 'skill:foo' }), undefined);
    assert.equal(toolNameFromRecord({ id: undefined }), undefined);
  });
});
