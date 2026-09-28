import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conformanceEmbedder } from '../../testing/rag-filter-conformance.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { symmetricEmbedder } from '../retrieval-embedder.js';
import { Bm25OnlyStrategy } from '../search-strategy.js';
import { tokenizeSearchText } from '../tokenizer.js';
import { VectorRag } from '../vector-rag.js';

const has = (text: string, ...tokens: string[]) => {
  const got = tokenizeSearchText(text);
  for (const t of tokens) assert.ok(got.includes(t), `${t} in ${got}`);
};

describe('tokenizeSearchText', () => {
  it('splits PascalCase / camelCase into parts and keeps the whole token', () => {
    has(
      'ReadFunctionInclude',
      'read',
      'function',
      'include',
      'readfunctioninclude',
    );
    has('getObjectInfo', 'get', 'object', 'info', 'getobjectinfo');
  });

  it('splits an acronym run from the next word', () => {
    has('GetXMLParser', 'get', 'xml', 'parser', 'getxmlparser');
  });

  it('splits snake_case into parts and keeps the whole token', () => {
    has('get_sql_query', 'get', 'sql', 'query', 'get_sql_query');
  });

  it('applies no suffix normalisation (measured: it lowered retrieval MRR)', () => {
    assert.deepEqual(tokenizeSearchText('includes queries'), [
      'includes',
      'queries',
    ]);
  });

  it('is deterministic and drops one-character tokens', () => {
    assert.deepEqual(tokenizeSearchText('a B c'), []);
    assert.deepEqual(
      tokenizeSearchText('Read the SQL'),
      tokenizeSearchText('Read the SQL'),
    );
  });
});

describe('the stores match a query against identifier parts', () => {
  const docs = [
    {
      id: 'tool:ReadFunctionInclude',
      text: 'Tool: ReadFunctionInclude — returns source',
    },
    { id: 'tool:GetTable', text: 'Tool: GetTable — returns source' },
  ];

  it('InMemoryRag: "function include" finds ReadFunctionInclude', async () => {
    const rag = new InMemoryRag();
    for (const d of docs) await rag.writer().upsertRaw(d.id, d.text, {});
    const res = await rag.query(
      { text: 'function include', toVector: async () => [] },
      2,
    );
    assert.ok(res.ok);
    assert.equal(res.value[0].metadata.id, 'tool:ReadFunctionInclude');
    assert.ok(res.value[0].score > res.value[1].score);
  });

  it('VectorRag BM25: "function include" finds ReadFunctionInclude', async () => {
    const e = conformanceEmbedder();
    const rag = new VectorRag(symmetricEmbedder(e), {
      strategy: new Bm25OnlyStrategy(),
    });
    for (const d of docs) await rag.writer().upsertRaw(d.id, d.text, {});
    const q = 'function include';
    const res = await rag.query(
      { text: q, toVector: async () => (await e.embed(q)).vector },
      2,
    );
    assert.ok(res.ok);
    assert.equal(res.value[0].metadata.id, 'tool:ReadFunctionInclude');
    assert.ok(res.value[0].score > res.value[1].score);
  });
});
