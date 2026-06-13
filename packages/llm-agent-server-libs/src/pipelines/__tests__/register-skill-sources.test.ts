import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IQueryEmbedding,
  IRag,
  ISkillPluginHost,
  ISkillsRagHandle,
  RagCollectionMeta,
  SkillGroupInfo,
  SkillHit,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { registerSkillSources } from '../register-skill-sources.js';
import type { IServerPipelineContext } from '../server-context.js';

/** Records every addRagCollection call; everything else is a no-op stub. */
interface RegisteredCollection {
  name: string;
  rag: IRag;
  meta?: Omit<RagCollectionMeta, 'name' | 'editable'>;
}

function makeMockBuilder(sink: RegisteredCollection[]): SmartAgentBuilder {
  const builder = {
    addRagCollection(params: RegisteredCollection) {
      sink.push(params);
      return builder;
    },
  };
  return builder as unknown as SmartAgentBuilder;
}

/** Stub handle: query() returns one SkillHit; capture the query args. */
function makeStubHandle(captured: { text?: string; k?: number }) {
  const hit: SkillHit = {
    record: {
      id: 'src:plugin@1/skillA#0',
      sourceId: 'src',
      group: 'g1',
      name: 'plugin/skillA',
      retrievalText: 'how to do A',
      content: 'CONTENT-A',
      provenance: 'plugin@1/skillA#0',
    },
    score: 0.91,
  };
  const handle: ISkillsRagHandle = {
    async query(text, opts) {
      captured.text = text;
      captured.k = opts.k;
      return [hit];
    },
    async activeManifest() {
      return null;
    },
  };
  return handle;
}

function makeStubHost(
  groups: SkillGroupInfo[],
  handle: ISkillsRagHandle,
): ISkillPluginHost {
  return {
    async load() {
      return { committed: [], omitted: [], tombstoned: [], ok: true };
    },
    groups() {
      return groups;
    },
    rag() {
      return handle;
    },
  };
}

/** Minimal context carrying only what the helper reads. */
function makeCtx(
  over: Partial<IServerPipelineContext>,
): IServerPipelineContext {
  return over as IServerPipelineContext;
}

describe('registerSkillSources', () => {
  it('registers exactly one skills source per group and queries the hit content', async () => {
    const sink: RegisteredCollection[] = [];
    const captured: { text?: string; k?: number } = {};
    const handle = makeStubHandle(captured);
    const host = makeStubHost(
      [{ group: 'g1', description: 'group one', collection: 'c1' }],
      handle,
    );
    const ctx = makeCtx({
      skillHost: host,
      skillRecall: { k: 7, threshold: 0.4 },
    });

    registerSkillSources(makeMockBuilder(sink), ctx);

    assert.equal(sink.length, 1);
    assert.equal(sink[0].name, 'relevant-skills:g1');
    assert.equal(sink[0].meta?.displayName, 'Relevant Skills');

    const embedding: IQueryEmbedding = {
      text: 'do A please',
      toVector: async () => [0, 0, 0],
    };
    const res = await sink[0].rag.query(embedding, 7);
    assert.ok(res.ok);
    assert.equal(res.value.length, 1);
    assert.equal(res.value[0].text, 'CONTENT-A');
    assert.equal(res.value[0].score, 0.91);
    // Source re-embeds via the handle from the query text, not the toVector().
    assert.equal(captured.text, 'do A please');
    assert.equal(captured.k, 7);
  });

  it('registers one source per group for multiple groups', () => {
    const sink: RegisteredCollection[] = [];
    const handle = makeStubHandle({});
    const host = makeStubHost(
      [
        { group: 'g1', description: '', collection: 'c1' },
        { group: 'g2', description: '', collection: 'c2' },
      ],
      handle,
    );
    const ctx = makeCtx({ skillHost: host, skillRecall: { k: 4 } });

    registerSkillSources(makeMockBuilder(sink), ctx);

    assert.deepEqual(
      sink.map((c) => c.name),
      ['relevant-skills:g1', 'relevant-skills:g2'],
    );
  });

  it('is a no-op when skillHost is absent', () => {
    const sink: RegisteredCollection[] = [];
    const ctx = makeCtx({});
    registerSkillSources(makeMockBuilder(sink), ctx);
    assert.equal(sink.length, 0);
  });
});
