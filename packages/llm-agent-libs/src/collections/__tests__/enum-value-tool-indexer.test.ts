import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IItemIndexer,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { isIndexNoteSource, RagError } from '@mcp-abap-adt/llm-agent';
import {
  EnumValueToolIndexer,
  FacetedToolIndexer,
  NamedDiscriminator,
  RequiredEnumDiscriminator,
  toolItemFromTool,
} from '../index.js';

// generic synthetic coarse server
const coarse = toolItemFromTool(
  {
    name: 'resource_create',
    description: 'Create a resource. Any kind',
    inputSchema: {
      properties: {
        kind: {
          oneOf: [
            { const: 'BUCKET', description: 'A storage bucket' },
            { const: 'QUEUE' },
          ],
        },
        format: { enum: ['json', 'yaml'] },
      },
      required: ['kind'],
    },
  },
  { itemId: 'tool:resource_create', originalName: 'resource_create' },
);
// labelled example: an mcp-abap-adt `compact`-shaped tool
const compactShaped = toolItemFromTool(
  {
    name: 'HandlerCreate',
    description: 'Create operation. Creates an object',
    inputSchema: {
      properties: { object_type: { enum: ['CLASS', 'BEHAVIOR_DEFINITION'] } },
      required: ['object_type'],
    },
  },
  { itemId: 'tool:HandlerCreate', originalName: 'HandlerCreate' },
);

describe('discriminators', () => {
  it('RequiredEnumDiscriminator: exactly one required property with ≥ 2 string values', () => {
    assert.equal(new RequiredEnumDiscriminator().select(coarse)?.name, 'kind');
  });
  it('optional enums are ignored; none qualifying → none', () => {
    const t = {
      ...coarse,
      parameters: coarse.parameters.filter((p) => p.name === 'format'),
    };
    assert.equal(new RequiredEnumDiscriminator().select(t), undefined);
  });
  it('several qualifying → none (D18: no fan-out, never a guess)', () => {
    const t = {
      ...coarse,
      parameters: [
        ...coarse.parameters,
        {
          name: 'region',
          required: true,
          values: [{ value: 'EU' }, { value: 'US' }],
        },
      ],
    };
    assert.equal(new RequiredEnumDiscriminator().select(t), undefined);
    assert.deepEqual(
      RequiredEnumDiscriminator.candidates(t).map((p) => p.name),
      ['kind', 'region'],
    );
  });
  it('NamedDiscriminator: present, absent, fewer than 2 values', () => {
    assert.equal(
      new NamedDiscriminator('object_type').select(compactShaped)?.name,
      'object_type',
    );
    assert.equal(
      new NamedDiscriminator('missing').select(compactShaped),
      undefined,
    );
    const one = {
      ...compactShaped,
      parameters: [
        { name: 'object_type', required: true, values: [{ value: 'CLASS' }] },
      ],
    };
    assert.equal(new NamedDiscriminator('object_type').select(one), undefined);
  });
});

describe('EnumValueToolIndexer', () => {
  const indexer = new EnumValueToolIndexer(new FacetedToolIndexer([]), {
    discriminator: new RequiredEnumDiscriminator(),
    maxValues: 5,
  });

  it('one value record per string value, collapsing to the tool', async () => {
    const r = await indexer.toRecords(coarse);
    assert.ok(r.ok);
    const values = r.value.filter((d) => d.recordKind === 'value');
    assert.deepEqual(
      values.map((d) => d.text),
      [
        'resource create — Create a resource — kind: bucket — A storage bucket',
        'resource create — Create a resource — kind: queue',
      ],
    );
    for (const d of values) {
      assert.equal(d.itemId, 'tool:resource_create');
      assert.equal(d.itemText, r.value[0].text);
    }
    assert.deepEqual(
      values.map((d) => d.metadata?.value),
      ['BUCKET', 'QUEUE'],
    );
    assert.deepEqual(
      values.map((d) => d.metadata?.parameter),
      ['kind', 'kind'],
    );
  });
  it('labelled example: compact-shaped tool with NamedDiscriminator', async () => {
    const r = await new EnumValueToolIndexer(new FacetedToolIndexer([]), {
      discriminator: new NamedDiscriminator('object_type'),
      maxValues: 2,
    }).toRecords(compactShaped);
    assert.ok(r.ok);
    assert.equal(
      r.value[1].text,
      'handler create — Create operation — object type: class',
    );
  });
  it('maxRecordsPerItem = inner + maxValues', () => {
    assert.equal(indexer.maxRecordsPerItem, 6);
  });
  it('more values than maxValues → TOO_MANY_RECORDS, nothing silently dropped', async () => {
    const r = await new EnumValueToolIndexer(new FacetedToolIndexer([]), {
      discriminator: new RequiredEnumDiscriminator(),
      maxValues: 1,
    }).toRecords(coarse);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.code === 'TOO_MANY_RECORDS');
  });
  it('no qualifying parameter → the inner records only', async () => {
    const r = await indexer.toRecords({ ...coarse, parameters: [] });
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((d) => d.recordKind),
      ['full'],
    );
  });
  it("forwards the caller's CallOptions to the inner indexer (IItemIndexer contract)", async () => {
    const faceted = new FacetedToolIndexer([]);
    const seen: (CallOptions | undefined)[] = [];
    const recording: IItemIndexer<ToolItem> = {
      name: faceted.name,
      canonicalKind: faceted.canonicalKind,
      maxRecordsPerItem: faceted.maxRecordsPerItem,
      toRecords: (item, options) => {
        seen.push(options);
        return faceted.toRecords(item, options);
      },
    };
    const options: CallOptions = {
      signal: new AbortController().signal,
      userId: 'u1',
    };
    const r = await new EnumValueToolIndexer(recording, {
      discriminator: new RequiredEnumDiscriminator(),
      maxValues: 5,
    }).toRecords(coarse, options);
    assert.ok(r.ok);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], options);
  });
  it('maxValues is required and positive (no library number)', () => {
    assert.throws(
      () =>
        new EnumValueToolIndexer(new FacetedToolIndexer([]), {
          discriminator: new RequiredEnumDiscriminator(),
          maxValues: 0,
        }),
    );
  });
});

describe('EnumValueToolIndexer never rejects', () => {
  it('a throwing discriminator → ok:false with the cause, not a rejection', async () => {
    const boom = new Error('selector exploded');
    const r = await new EnumValueToolIndexer(new FacetedToolIndexer([]), {
      discriminator: {
        name: 'boom',
        select: () => {
          throw boom;
        },
      },
      maxValues: 5,
    }).toRecords(coarse);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.message.includes('tool:resource_create'));
    assert.ok(!r.ok && r.error.message.includes('selector exploded'));
    assert.ok(!r.ok && r.error.cause === boom);
  });
  it('an inner indexer that rejects → ok:false with the cause', async () => {
    const boom = new Error('inner rejected');
    const inner: IItemIndexer<ToolItem> = {
      name: 'x',
      canonicalKind: 'full',
      maxRecordsPerItem: 1,
      toRecords: () => Promise.reject(boom),
    };
    const r = await new EnumValueToolIndexer(inner, {
      discriminator: new RequiredEnumDiscriminator(),
      maxValues: 5,
    }).toRecords(coarse);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.message.includes('inner rejected'));
    assert.ok(!r.ok && r.error.cause === boom);
  });
  it('an inner failure is returned unchanged', async () => {
    const inner: IItemIndexer<ToolItem> = {
      name: 'x',
      canonicalKind: 'full',
      maxRecordsPerItem: 1,
      toRecords: async () => ({
        ok: false,
        error: new RagError('inner failed'),
      }),
    };
    const r = await new EnumValueToolIndexer(inner, {
      discriminator: new RequiredEnumDiscriminator(),
      maxValues: 5,
    }).toRecords(coarse);
    assert.ok(!r.ok && r.error.message === 'inner failed');
  });
});

describe('ambiguous-discriminator notes (S1)', () => {
  const ambiguous = {
    ...coarse,
    parameters: [
      ...coarse.parameters,
      {
        name: 'region',
        required: true,
        values: [{ value: 'EU' }, { value: 'US' }],
      },
    ],
  };
  it('RequiredEnumDiscriminator: several qualifying → one note with the candidates; otherwise none', () => {
    const d = new RequiredEnumDiscriminator();
    assert.deepEqual(d.notesFor(ambiguous), [
      { note: 'ambiguous-discriminator', detail: 'kind, region' },
    ]);
    assert.deepEqual(d.notesFor(coarse), []);
  });
  it("EnumValueToolIndexer forwards its discriminator's notes; NamedDiscriminator has none", () => {
    const viaRequired = new EnumValueToolIndexer(new FacetedToolIndexer([]), {
      discriminator: new RequiredEnumDiscriminator(),
      maxValues: 5,
    });
    assert.equal(isIndexNoteSource(viaRequired), true);
    assert.deepEqual(viaRequired.notesFor(ambiguous), [
      { note: 'ambiguous-discriminator', detail: 'kind, region' },
    ]);
    const viaNamed = new EnumValueToolIndexer(new FacetedToolIndexer([]), {
      discriminator: new NamedDiscriminator('kind'),
      maxValues: 5,
    });
    assert.deepEqual(viaNamed.notesFor(ambiguous), []);
  });
  it('indexer level: ambiguity → inner records only; NamedDiscriminator picks the parameter', async () => {
    const viaRequired = await new EnumValueToolIndexer(
      new FacetedToolIndexer([]),
      {
        discriminator: new RequiredEnumDiscriminator(),
        maxValues: 5,
      },
    ).toRecords(ambiguous);
    assert.ok(viaRequired.ok);
    assert.deepEqual(
      viaRequired.value.map((d) => d.recordKind),
      ['full'],
    );
    const viaNamed = await new EnumValueToolIndexer(
      new FacetedToolIndexer([]),
      {
        discriminator: new NamedDiscriminator('kind'),
        maxValues: 5,
      },
    ).toRecords(ambiguous);
    assert.ok(viaNamed.ok);
    assert.equal(
      viaNamed.value.filter((d) => d.recordKind === 'value').length,
      2,
    );
  });
  it("forwards the inner indexer's notes too", () => {
    const inner = Object.assign(new FacetedToolIndexer([]), {
      notesFor: () => [{ note: 'inner-note' }],
    });
    const x = new EnumValueToolIndexer(inner, {
      discriminator: new NamedDiscriminator('kind'),
      maxValues: 5,
    });
    assert.deepEqual(x.notesFor(coarse), [{ note: 'inner-note' }]);
  });
});
