// packages/llm-agent-libs/src/collections/__tests__/faceted-tool-indexer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EnumValuesToolText,
  FacetedToolIndexer,
  fullToolText,
  NameTailFacet,
  ParameterNamesToolText,
  ParametersFacet,
  SchemaToolText,
  SummaryFacet,
  toolItemFromTool,
} from '../index.js';

const tool = toolItemFromTool(
  {
    name: 'gh__listPullRequests',
    description: '[beta] List pull requests of a repo. Paged',
    inputSchema: {
      properties: {
        repo_name: { type: 'string', description: 'Repository; owner/name' },
        state: { type: 'string', enum: ['OPEN', 'MERGED_ALL'] },
      },
      required: ['repo_name'],
    },
  },
  { itemId: 'tool:listPullRequests', originalName: 'listPullRequests' },
);

describe('facets — provider text only', () => {
  it('SummaryFacet: name words — first clause', () => {
    assert.equal(
      new SummaryFacet().derive(tool),
      'list pull requests — List pull requests of a repo',
    );
  });
  it('SummaryFacet: no first clause → no record', () => {
    assert.equal(
      new SummaryFacet().derive({ ...tool, description: '[tag]' }),
      undefined,
    );
  });
  it('ParametersFacet: schema order, first clause of each description, value words', () => {
    assert.equal(
      new ParametersFacet().derive(tool),
      'list pull requests — repo name (Repository); state: open, merged all',
    );
  });
  it('ParametersFacet: no parameters → no record', () => {
    assert.equal(
      new ParametersFacet().derive({ ...tool, parameters: [] }),
      undefined,
    );
  });
  it('NameTailFacet: verb-first, object-first, single-word (documents its convention)', () => {
    const f = new NameTailFacet();
    assert.equal(f.derive({ ...tool, originalName: 'GetClass' }), 'class');
    assert.equal(f.derive({ ...tool, originalName: 'class_get' }), 'get');
    assert.equal(f.derive({ ...tool, originalName: 'fetch' }), undefined);
  });
});

describe('FacetedToolIndexer', () => {
  const indexer = new FacetedToolIndexer([
    new SummaryFacet(),
    new ParametersFacet(),
  ]);

  it('full is canonical and always written; facets carry itemText', async () => {
    const r = await indexer.toRecords(tool);
    assert.ok(r.ok);
    const [full, ...rest] = r.value;
    assert.equal(full.recordKind, 'full');
    assert.equal(
      full.text,
      'Tool: gh__listPullRequests — [beta] List pull requests of a repo. Paged\nParameters: repo_name, state',
    );
    assert.deepEqual(full.owner, { scope: 'global' });
    assert.deepEqual(full.metadata, {
      name: 'gh__listPullRequests',
      definitionChars: tool.definitionChars,
    });
    assert.equal(full.itemText, undefined);
    assert.deepEqual(
      rest.map((d) => d.recordKind),
      ['summary', 'parameters'],
    );
    for (const d of rest) {
      assert.equal(d.itemText, full.text);
      assert.equal(d.itemId, 'tool:listPullRequests');
    }
  });
  it('maxRecordsPerItem = 1 + facets, and bounds what it writes', async () => {
    assert.equal(indexer.maxRecordsPerItem, 3);
    const r = await indexer.toRecords(tool);
    assert.ok(r.ok && r.value.length <= indexer.maxRecordsPerItem);
  });
  it('full only: FacetedToolIndexer([])', async () => {
    const r = await new FacetedToolIndexer([]).toRecords(tool);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((d) => d.recordKind),
      ['full'],
    );
  });
  it('a tool without parameters has no Parameters line', async () => {
    const r = await new FacetedToolIndexer([]).toRecords({
      ...tool,
      parameters: [],
    });
    assert.ok(r.ok);
    assert.equal(
      r.value[0].text,
      'Tool: gh__listPullRequests — [beta] List pull requests of a repo. Paged',
    );
  });
  it('refuses a facet named full or two facets of one kind', () => {
    assert.throws(
      () => new FacetedToolIndexer([{ kind: 'full', derive: () => 'x' }]),
    );
    assert.throws(
      () => new FacetedToolIndexer([new SummaryFacet(), new SummaryFacet()]),
    );
  });
});

describe('provider text composers (F4) — the default stays C0', () => {
  it('no text option → ParameterNamesToolText, byte-identical to fullToolText', async () => {
    const i = new FacetedToolIndexer([new SummaryFacet()]);
    assert.ok(i.text instanceof ParameterNamesToolText);
    assert.equal(
      new ParameterNamesToolText().compose(tool),
      fullToolText(tool),
    );
  });
  it('EnumValuesToolText (C0e): C0 + the string values of each parameter that has them', () => {
    assert.equal(
      new EnumValuesToolText().compose(tool),
      `${fullToolText(tool)}\nstate: OPEN, MERGED_ALL`,
    );
  });
  it('SchemaToolText (C0s): C0 + each parameter description first clause and values', () => {
    assert.equal(
      new SchemaToolText().compose(tool),
      `${fullToolText(tool)}\nrepo_name: Repository\nstate: values OPEN, MERGED_ALL`,
    );
  });
  it('the composer text is the full record text AND every facet itemText', async () => {
    const r = await new FacetedToolIndexer([new SummaryFacet()], {
      text: new EnumValuesToolText(),
    }).toRecords(tool);
    assert.ok(r.ok);
    const [full, summary] = r.value;
    assert.equal(full.text, new EnumValuesToolText().compose(tool));
    assert.equal(summary.itemText, full.text);
  });
});
