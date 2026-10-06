import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IRag, ISkillManager } from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import { SmartAgentBuilder } from '../builder.js';
import { makeLlm } from '../testing/index.js';

const manager = {
  listSkills: async () => ({
    ok: true as const,
    value: [{ name: 'skill-a', description: 'does a' }],
  }),
  getSkill: async () => ({ ok: false as const, error: new Error('n/a') }),
} as unknown as ISkillManager;

function spyRag(ids: string[]): IRag {
  const rag = new InMemoryRag();
  const w = rag.writer();
  if (w) {
    const orig = w.upsertRaw.bind(w);
    w.upsertRaw = (id, text, meta, opts) => {
      ids.push(id);
      return orig(id, text, meta, opts);
    };
    rag.writer = () => w;
  }
  return rag;
}

async function build(
  configure: (b: SmartAgentBuilder) => SmartAgentBuilder,
): Promise<string[]> {
  const ids: string[] = [];
  const b = new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setToolsRag(spyRag(ids));
  const h = await configure(b).build();
  await h.close();
  return ids;
}

test('skills are vectorized into the tools store by default', async () => {
  const ids = await build((b) => b.withSkillManager(manager));
  assert.ok(
    ids.some((i) => i.includes('skill-a')),
    ids.join(','),
  );
});

test('withSkillManager(m, { vectorize: false }) writes nothing to the tools store', async () => {
  const ids = await build((b) =>
    b.withSkillManager(manager, { vectorize: false }),
  );
  assert.deepEqual(ids, []);
});
