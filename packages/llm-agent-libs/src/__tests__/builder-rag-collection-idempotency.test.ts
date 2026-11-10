import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRag, SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { makeLlm } from '../testing/index.js';

// addRagCollection registers into the (possibly shared) RAG registry at build().
// A registry is shared across per-session pipeline builds, so the skills-wiring
// caller re-issues the SAME collection every build — it opts into `idempotent`.
// Ordinary callers do NOT, so a genuine name collision still fails loud instead
// of silently keeping the old RAG/editor/meta.

const stubRag = () => new InMemoryRag();

test('addRagCollection: idempotent collection re-issued against a shared registry is skipped (no throw)', async () => {
  const reg = new SimpleRagRegistry();
  const h1 = await new SmartAgentBuilder({})
    .withRagAccess(testRagAccess())
    .withMainLlm(makeLlm([{ content: 'a' }]))
    .setRagRegistry(reg)
    .addRagCollection({
      name: 'relevant-skills:sap',
      rag: stubRag(),
      meta: { displayName: 'Skills', scope: 'global' },
      idempotent: true,
    })
    .build()
    .then(unwrapBuilderResult);
  // Second build over the SAME shared registry re-issues the same idempotent
  // collection (the per-session skills-wiring case) — must NOT throw.
  const h2 = await new SmartAgentBuilder({})
    .withRagAccess(testRagAccess())
    .withMainLlm(makeLlm([{ content: 'b' }]))
    .setRagRegistry(reg)
    .addRagCollection({
      name: 'relevant-skills:sap',
      rag: stubRag(),
      meta: { displayName: 'Skills', scope: 'global' },
      idempotent: true,
    })
    .build()
    .then(unwrapBuilderResult);
  assert.ok(reg.get('relevant-skills:sap'), 'collection stays registered');
  await h1.close();
  await h2.close();
});

test('addRagCollection: ordinary duplicate name (no idempotent flag) still fails loud', async () => {
  const reg = new SimpleRagRegistry();
  const h1 = await new SmartAgentBuilder({})
    .withRagAccess(testRagAccess())
    .withMainLlm(makeLlm([{ content: 'a' }]))
    .setRagRegistry(reg)
    .addRagCollection({
      name: 'kb',
      rag: stubRag(),
      meta: { displayName: 'kb', scope: 'global' },
    })
    .build()
    .then(unwrapBuilderResult);
  await assert.rejects(
    () =>
      new SmartAgentBuilder({})
        .withRagAccess(testRagAccess())
        .withMainLlm(makeLlm([{ content: 'b' }]))
        .setRagRegistry(reg)
        .addRagCollection({
          name: 'kb',
          rag: stubRag(),
          meta: { displayName: 'kb', scope: 'global' },
        })
        .build()
        .then(unwrapBuilderResult),
    /already registered/,
    'a non-idempotent duplicate name must surface the collision',
  );
  await h1.close();
});
