/**
 * Spec §10.5.8 S-2–S-7 (D74, D75) — skills fail loud: the legacy orchestrator
 * returns a failing skill source's error; an unreadable skill directory or a
 * broken `SKILL.md` is a SkillError naming it; a skill that cannot be written
 * into the tools store, or a plugin loader `errors` entry (a plugin it was
 * told to load — S-6 amended by D96), fails `build()`; the runtime
 * skills recall throws on an incompatible generation and rethrows an abort.
 * Kept (absent by design): a default skill path that does not exist, a
 * directory without `SKILL.md`.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  IRag,
  ISkill,
  ISkillManager,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  RagError,
  SkillError,
  SkillsIncompatibleError,
  SmartAgentError,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import { SmartAgent } from '../../agent.js';
import { SmartAgentBuilder } from '../../builder.js';
import { emptyLoadedPlugins } from '../../plugins/types.js';
import {
  makeClassifier,
  makeDefaultDeps,
  makeLlm,
} from '../../testing/index.js';
import { FileSystemSkillManager } from '../filesystem-skill-manager.js';
import { makeCompatibleSkillsRag } from '../plugin-host/compatible-skills-rag.js';
import { scanDirsForSkills } from '../skill-utils.js';

// chmod 000 does not deny root, and Windows has no POSIX modes.
const noPermissionTests =
  process.platform === 'win32' || process.getuid?.() === 0;

function skill(
  name: string,
  content: Result<string, SkillError> = { ok: true, value: `body ${name}` },
): ISkill {
  return {
    name,
    description: `does ${name}`,
    meta: { name, description: `does ${name}` },
    getContent: async () => content,
    listResources: async () => ({ ok: true as const, value: [] }),
    readResource: async () => ({ ok: true as const, value: '' }),
  };
}

function manager(list: Result<ISkill[], SkillError>): ISkillManager {
  return {
    listSkills: async () => list,
    getSkill: async () => ({ ok: true as const, value: undefined }),
    matchSkills: async () => list,
  };
}

/** A store whose first query (the main RAG query) answers `first`, every later one `later`. */
function twoPhaseStore(
  first: () => Promise<unknown>,
  later: () => Promise<unknown>,
): IRag {
  let calls = 0;
  return {
    async query() {
      calls++;
      return calls === 1 ? first() : later();
    },
    async healthCheck() {
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRag;
}

const empty = async () => ({ ok: true as const, value: [] });

async function processWith(
  store: IRag,
  m: ISkillManager,
): Promise<Awaited<ReturnType<SmartAgent['process']>>> {
  const { deps } = makeDefaultDeps({
    ragStores: { kb: store },
    classifier: makeClassifier([{ type: 'action', text: 'read program' }]),
  });
  return new SmartAgent(
    { ...deps, skillManager: m },
    { maxIterations: 3 },
  ).process('read program');
}

describe('S-2 legacy orchestrator: a failing skill source is the request error', () => {
  it('the dedicated skill query answering ok:false → process() returns the store code', async () => {
    const r = await processWith(
      twoPhaseStore(empty, async () => ({
        ok: false as const,
        error: new RagError('skill query down', 'QUERY_ERROR'),
      })),
      manager({ ok: true, value: [skill('a')] }),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'QUERY_ERROR');
    assert.match(r.error.message, /skill.*"kb".*skill query down/);
  });

  it('the dedicated skill query rejecting → process() returns its code', async () => {
    const r = await processWith(
      twoPhaseStore(empty, async () => {
        throw new RagError('embedder gone', 'EMBED_ERROR');
      }),
      manager({ ok: true, value: [skill('a')] }),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'EMBED_ERROR');
  });

  it('listSkills ok:false → process() returns SKILL_ERROR', async () => {
    const r = await processWith(
      twoPhaseStore(empty, empty),
      manager({ ok: false, error: new SkillError('cannot list') }),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SKILL_ERROR');
    assert.match(r.error.message, /cannot list/);
  });

  it('a matched skill whose getContent fails → process() returns SKILL_ERROR naming it', async () => {
    const hit = async () => ({
      ok: true as const,
      value: [{ text: 's', score: 1, metadata: { id: 'skill:a' } }],
    });
    const r = await processWith(
      twoPhaseStore(hit, hit),
      manager({
        ok: true,
        value: [skill('a', { ok: false, error: new SkillError('gone') })],
      }),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SKILL_ERROR');
    assert.match(r.error.message, /skill "a".*gone/);
  });

  it('the main RAG query rejecting with a non-Rag SmartAgentError keeps its code', async () => {
    const r = await processWith(
      twoPhaseStore(async () => {
        throw new SmartAgentError('breaker open', 'CIRCUIT_OPEN');
      }, empty),
      manager({ ok: true, value: [skill('a')] }),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
  });

  it('the dedicated skill query rejecting with a non-Rag SmartAgentError keeps its code', async () => {
    const r = await processWith(
      twoPhaseStore(empty, async () => {
        throw new SmartAgentError('breaker open', 'CIRCUIT_OPEN');
      }),
      manager({ ok: true, value: [skill('a')] }),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
  });

  it('listSkills rejecting with a plain Error → process() returns SKILL_ERROR', async () => {
    const r = await processWith(twoPhaseStore(empty, empty), {
      ...manager({ ok: true, value: [] }),
      listSkills: async () => {
        throw new Error('list exploded');
      },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SKILL_ERROR');
    assert.match(r.error.message, /list exploded/);
  });

  it('getContent rejecting with a SmartAgentError keeps its code, naming the skill', async () => {
    const hit = async () => ({
      ok: true as const,
      value: [{ text: 's', score: 1, metadata: { id: 'skill:a' } }],
    });
    const rejecting: ISkill = {
      ...skill('a'),
      getContent: async () => {
        throw new SmartAgentError('content gone', 'CONTENT_GONE');
      },
    };
    const r = await processWith(
      twoPhaseStore(hit, hit),
      manager({ ok: true, value: [rejecting] }),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CONTENT_GONE');
    assert.match(r.error.message, /skill "a".*content gone/);
  });
});

describe('S-3 / S-4 filesystem skills', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-fail-loud-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('S-3: a directory that does not exist is skipped (ENOENT kept)', async () => {
    const skills = await scanDirsForSkills([join(root, 'nope')]);
    assert.deepEqual(skills, []);
  });

  it('S-3: a directory whose readdir fails with EACCES → SkillError naming it', {
    skip: noPermissionTests,
  }, async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await assert.rejects(
        scanDirsForSkills([locked]),
        (e: unknown) =>
          e instanceof SkillError &&
          e.message.includes(locked) &&
          /EACCES/.test(e.message),
      );
      const listed = await new FileSystemSkillManager([locked]).listSkills();
      assert.ok(!listed.ok);
      assert.match(listed.error.message, /EACCES/);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('S-4: a directory without SKILL.md is not a skill (kept)', async () => {
    const base = join(root, 'no-skill-md');
    await mkdir(join(base, 'just-a-dir'), { recursive: true });
    const listed = await new FileSystemSkillManager([base]).listSkills();
    assert.ok(listed.ok);
    assert.deepEqual(listed.value, []);
  });

  it('S-4: a SKILL.md with broken frontmatter → listSkills returns a SkillError naming the file', async () => {
    const base = join(root, 'broken');
    const dir = join(base, 'bad');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, '---\nname: [unclosed\n---\nbody\n');
    const listed = await new FileSystemSkillManager([base]).listSkills();
    assert.ok(!listed.ok);
    assert.ok(listed.error instanceof SkillError);
    assert.ok(listed.error.message.includes(file), listed.error.message);
  });

  it('S-4: a SKILL.md that cannot be read → listSkills returns a SkillError naming the file', {
    skip: noPermissionTests,
  }, async () => {
    const base = join(root, 'unreadable');
    const dir = join(base, 'secret');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, '---\nname: secret\n---\nbody\n');
    await chmod(file, 0o000);
    try {
      const listed = await new FileSystemSkillManager([base]).listSkills();
      assert.ok(!listed.ok);
      assert.ok(listed.error.message.includes(file), listed.error.message);
    } finally {
      await chmod(file, 0o644);
    }
  });
});

describe('S-5 / S-6 builder', () => {
  it('S-5: a skill that cannot be written into the tools store fails build()', async () => {
    const rag = new InMemoryRag();
    const w = rag.writer();
    assert.ok(w);
    const upsertRaw = w.upsertRaw.bind(w);
    w.upsertRaw = async (id, ...rest) =>
      id.startsWith('skill:')
        ? { ok: false as const, error: new RagError('skill store down') }
        : upsertRaw(id, ...rest);
    rag.writer = () => w;
    const b = new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setToolsRag(rag)
      .withSkillManager(manager({ ok: true, value: [skill('demo')] }));
    await assert.rejects(
      b.build(),
      (e: unknown) =>
        e instanceof SkillError &&
        /skill "demo" \(skill:demo\).*skill store down/.test(e.message),
    );
  });

  it('S-6 (D96): a plugin loader that reports errors (plugins it was told to load) fails build(), naming every file', async () => {
    const b = new SmartAgentBuilder({})
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .withPluginLoader({
        load: async () => ({
          ...emptyLoadedPlugins(),
          errors: [
            { file: 'p.js', error: 'boom' },
            { file: 'q.js', error: 'bang' },
          ],
        }),
      });
    await assert.rejects(b.build(), /p\.js.*boom.*q\.js.*bang/s);
  });
});

describe('S-7 CompatibleSkillsRag.query', () => {
  const MANIFEST = {
    embeddingSpaceId: 'sp',
    dimension: 3,
    retrievalSchemaVersion: 1,
  };
  const embedder = symmetricEmbedder({
    embed: async () => ({ vector: [1, 0, 0] }),
  });

  it('an incompatible generation throws SkillsIncompatibleError', async () => {
    const rag = makeCompatibleSkillsRag({
      backend: {
        activeSnapshot: async () => ({
          revision: 'g1',
          manifest: { ...MANIFEST, embeddingSpaceId: 'OTHER' },
        }),
        release() {},
        queryRevision: async () => [],
      } as never,
      embedder: embedder as never,
      embeddingSpaceId: 'sp',
      retrievalSchemaVersion: 1,
      dimension: 3,
    });
    await assert.rejects(
      rag.query('q', { k: 1 }),
      (e: unknown) => e instanceof SkillsIncompatibleError,
    );
  });

  it("an AbortError is rethrown (the caller's cancellation, not an empty answer)", async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const rag = makeCompatibleSkillsRag({
      backend: {
        activeSnapshot: async () => ({ revision: 'g0', manifest: MANIFEST }),
        release() {},
        queryRevision: async () => {
          throw abort;
        },
      } as never,
      embedder: embedder as never,
      embeddingSpaceId: 'sp',
      retrievalSchemaVersion: 1,
      dimension: 3,
    });
    await assert.rejects(rag.query('q', { k: 1 }), (e: unknown) => e === abort);
  });
});
