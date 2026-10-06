/**
 * vectorizeSkills — spec §10.5.8 S-5, D75: a failed listing, or a skill whose
 * write fails (`ok: false` or a throw), rejects with a SkillError naming the
 * skill, the store's error as `cause`, at the first failing skill. A writerless
 * store is skipped (absent by design).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IRag,
  IRagBackendWriter,
  IRequestLogger,
  ISkillManager,
} from '@mcp-abap-adt/llm-agent';
import { RagError, SkillError } from '@mcp-abap-adt/llm-agent';
import { vectorizeSkills } from '../mcp/vectorize-mcp-tools.js';

// ---------------------------------------------------------------------------
// Helpers / stubs
// ---------------------------------------------------------------------------

interface LlmCallEntry {
  component: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated: boolean;
  scope?: string;
  detail?: string;
}

class CapturingRequestLogger implements IRequestLogger {
  calls: LlmCallEntry[] = [];
  logLlmCall(entry: LlmCallEntry): void {
    this.calls.push(entry);
  }
}

function makeSkillManager(
  skills: Array<{ name: string; description: string }>,
  ok = true,
): ISkillManager {
  return {
    listSkills: async () =>
      ok
        ? { ok: true as const, value: skills }
        : { ok: false as const, error: new SkillError('list failed') },
    getSkill: async () => ({
      ok: false as const,
      error: new Error('not impl'),
    }),
  } as unknown as ISkillManager;
}

function makeWriter(opts?: {
  failUpsert?: boolean;
  throwUpsert?: Error;
  failIds?: string[];
}): IRagBackendWriter & { upsertCalls: Array<{ id: string; text: string }> } {
  const upsertCalls: Array<{ id: string; text: string }> = [];
  return {
    upsertCalls,
    async upsertRaw(id: string, text: string, _meta: object) {
      upsertCalls.push({ id, text });
      if (opts?.throwUpsert) throw opts.throwUpsert;
      if (opts?.failUpsert || opts?.failIds?.includes(id))
        return { ok: false as const, error: new RagError('write error') };
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagBackendWriter & {
    upsertCalls: Array<{ id: string; text: string }>;
  };
}

function makeRag(writer: IRagBackendWriter): IRag {
  return {
    query: async () => [],
    lookup: async () => undefined,
    writer: () => writer,
  } as unknown as IRag;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vectorizeSkills', () => {
  it('per-skill upsertRaw and estimated logLlmCall for each skill', async () => {
    const skills = [
      { name: 'skill-a', description: 'does a' },
      { name: 'skill-b', description: 'does b' },
    ];
    const writer = makeWriter();
    const rag = makeRag(writer);
    const reqLogger = new CapturingRequestLogger();

    await vectorizeSkills(makeSkillManager(skills), rag, reqLogger);

    // per-skill upsert with correct key and text
    assert.equal(writer.upsertCalls.length, 2);
    assert.ok(
      writer.upsertCalls.some(
        (c) => c.id === 'skill:skill-a' && c.text === 'Skill: skill-a\ndoes a',
      ),
    );
    assert.ok(
      writer.upsertCalls.some(
        (c) => c.id === 'skill:skill-b' && c.text === 'Skill: skill-b\ndoes b',
      ),
    );
    // per-skill logLlmCall
    assert.equal(reqLogger.calls.length, 2);
    assert.ok(reqLogger.calls.every((c) => c.estimated === true));
    assert.ok(reqLogger.calls.every((c) => c.detail === 'skills'));
    assert.ok(reqLogger.calls.every((c) => c.scope === 'initialization'));
  });

  it('S-5: upsertRaw answering {ok:false} rejects with a SkillError naming the skill, the store error as cause', async () => {
    const skills = [{ name: 'bad-skill', description: 'fails' }];
    const writer = makeWriter({ failUpsert: true });
    const reqLogger = new CapturingRequestLogger();

    const err = await vectorizeSkills(
      makeSkillManager(skills),
      makeRag(writer),
      reqLogger,
    ).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof SkillError);
    assert.match(err.message, /skill "bad-skill" \(skill:bad-skill\)/);
    assert.match(err.message, /write error/);
    assert.ok(err.cause instanceof RagError);
    // no logLlmCall on failure
    assert.equal(reqLogger.calls.length, 0);
  });

  it('S-5: upsertRaw throwing rejects with a SkillError naming the skill, the thrown error as cause', async () => {
    const skills = [{ name: 'bad-skill', description: 'fails' }];
    const thrown = new Error('disk full');
    const writer = makeWriter({ throwUpsert: thrown });

    const err = await vectorizeSkills(
      makeSkillManager(skills),
      makeRag(writer),
      new CapturingRequestLogger(),
    ).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof SkillError);
    assert.match(err.message, /skill "bad-skill".*disk full/);
    assert.equal(err.cause, thrown);
  });

  it('S-5: the first failing skill stops the run — no later skill is written', async () => {
    const skills = [
      { name: 'bad-skill', description: 'fails' },
      { name: 'good-skill', description: 'never reached' },
    ];
    const writer = makeWriter({ failIds: ['skill:bad-skill'] });

    await assert.rejects(
      vectorizeSkills(
        makeSkillManager(skills),
        makeRag(writer),
        new CapturingRequestLogger(),
      ),
      /skill "bad-skill"/,
    );
    assert.deepEqual(
      writer.upsertCalls.map((c) => c.id),
      ['skill:bad-skill'],
    );
  });

  it('S-5: listSkills returning {ok:false} rejects with that SkillError, no upserts', async () => {
    const writer = makeWriter();
    const reqLogger = new CapturingRequestLogger();

    await assert.rejects(
      vectorizeSkills(makeSkillManager([], false), makeRag(writer), reqLogger),
      (e: unknown) => e instanceof SkillError && e.message === 'list failed',
    );
    assert.equal(writer.upsertCalls.length, 0);
    assert.equal(reqLogger.calls.length, 0);
  });

  it('a writerless store resolves, nothing attempted (absent by design)', async () => {
    let listed = 0;
    const manager = {
      listSkills: async () => {
        listed++;
        return { ok: true as const, value: [] };
      },
    } as unknown as ISkillManager;
    const rag = { query: async () => [] } as unknown as IRag;
    await vectorizeSkills(manager, rag, new CapturingRequestLogger());
    assert.equal(listed, 0);
  });
});
