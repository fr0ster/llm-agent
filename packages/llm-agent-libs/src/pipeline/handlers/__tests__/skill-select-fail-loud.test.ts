/**
 * Spec §10.5.8 S-1 — the skill-select stage fails loud: a store whose skill
 * query fails fails the stage with the store's code; a failed `listSkills` or a
 * selected skill whose content cannot be read fails it with SKILL_ERROR. An
 * empty answer (a query that succeeded with no skill hits) stays honest.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IRag,
  ISkill,
  ISkillManager,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { RagError, SkillError } from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { SkillSelectHandler } from '../skill-select.js';

const span = {
  setAttribute() {},
  setStatus() {},
  addEvent() {},
  end() {},
} as unknown as ISpan;

function store(answer: () => Promise<Result<RagResult[], RagError>>): IRag {
  return {
    query: answer,
    async healthCheck() {
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRag;
}

function skill(
  name: string,
  content: Result<string, SkillError> = { ok: true, value: `body ${name}` },
): ISkill {
  return {
    name,
    description: `does ${name}`,
    meta: { name, description: `does ${name}` },
    getContent: async () => content,
  } as unknown as ISkill;
}

function manager(list: Result<ISkill[], SkillError>): ISkillManager {
  return {
    listSkills: async () => list,
  } as unknown as ISkillManager;
}

function ctx(stores: Record<string, IRag>, m: ISkillManager): PipelineContext {
  return {
    ragText: 'q',
    inputText: 'q',
    ragStores: stores,
    ragResults: {},
    options: undefined,
    sessionId: 's1',
    config: { ragQueryK: 5, mode: 'smart' },
    skillManager: m,
  } as unknown as PipelineContext;
}

const okList = manager({ ok: true, value: [skill('a')] });

describe('S-1 skill-select: a failing skill source fails the stage', () => {
  it('a store whose skill query answers ok:false → the store code', async () => {
    const c = ctx(
      {
        tools: store(async () => ({
          ok: false,
          error: new RagError('store down', 'QUERY_ERROR'),
        })),
      },
      okList,
    );
    const ok = await new SkillSelectHandler().execute(c, {}, span);
    assert.equal(ok, false);
    assert.equal(c.error?.code, 'QUERY_ERROR');
    assert.match(c.error?.message ?? '', /skill-select.*"tools".*store down/);
  });

  it('a store whose skill query rejects → the RagError code, named', async () => {
    const c = ctx(
      {
        tools: store(async () => {
          throw new RagError('embedder gone', 'EMBED_ERROR');
        }),
      },
      okList,
    );
    const ok = await new SkillSelectHandler().execute(c, {}, span);
    assert.equal(ok, false);
    assert.equal(c.error?.code, 'EMBED_ERROR');
    assert.match(c.error?.message ?? '', /"tools".*embedder gone/);
  });

  it('listSkills answering ok:false → SKILL_ERROR', async () => {
    const c = ctx(
      { tools: store(async () => ({ ok: true, value: [] })) },
      manager({ ok: false, error: new SkillError('cannot list') }),
    );
    const ok = await new SkillSelectHandler().execute(c, {}, span);
    assert.equal(ok, false);
    assert.equal(c.error?.code, 'SKILL_ERROR');
    assert.match(c.error?.message ?? '', /skill-select.*cannot list/);
  });

  it('a selected skill whose content cannot be read → SKILL_ERROR naming it', async () => {
    const c = ctx(
      {
        tools: store(async () => ({
          ok: true,
          value: [
            { text: 'x', score: 1, metadata: { id: 'skill:a' } } as RagResult,
          ],
        })),
      },
      manager({
        ok: true,
        value: [skill('a', { ok: false, error: new SkillError('gone') })],
      }),
    );
    const ok = await new SkillSelectHandler().execute(c, {}, span);
    assert.equal(ok, false);
    assert.equal(c.error?.code, 'SKILL_ERROR');
    assert.match(c.error?.message ?? '', /skill "a".*gone/);
  });

  it('a query that succeeded with no skill hits is an honest empty answer (kept)', async () => {
    const c = ctx(
      { tools: store(async () => ({ ok: true, value: [] })) },
      okList,
    );
    const ok = await new SkillSelectHandler().execute(c, {}, span);
    assert.equal(ok, true);
    assert.equal(c.error, undefined);
    assert.deepEqual(c.selectedSkills, []);
  });
});
