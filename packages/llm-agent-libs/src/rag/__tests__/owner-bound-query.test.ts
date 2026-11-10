import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  RagAccessDeniedError,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { makeRag } from '../../testing/index.js';
import { NoopTracer } from '../../tracer/noop-tracer.js';
import { type OwnedRagStore, ownerBoundQuery } from '../owner-bound-query.js';
import {
  callerA,
  orchestrator,
  sessionTags,
  sharedGlobalStore,
  sharedStore,
} from './isolation-fixtures.js';

it('a shared in-memory store returns only A records through RagOrchestrator.orchestrate', async () => {
  const result = await orchestrator(await sharedStore()).orchestrate('record', {
    opts: { caller: callerA },
    sessionId: 'A',
    mode: 'hard',
    externalTools: [],
    rootSpan: new NoopTracer().startSpan('test'),
  });
  assert.ok(result.ok);
  assert.deepEqual(sessionTags(result.value.retrieved.ragResults.history), [
    'A',
  ]);
});

for (const opts of [
  undefined,
  { caller: callerA, ragFilter: { sessionId: 'B' } },
]) {
  it(`RagOrchestrator refuses ${opts ? 'a smuggled sessionId' : 'a missing caller'}`, async () => {
    const result = await orchestrator(await sharedStore()).orchestrate(
      'record',
      {
        opts,
        sessionId: 'A',
        mode: 'hard',
        externalTools: [],
        rootSpan: new NoopTracer().startSpan('test'),
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
  });
}

const caller = { sessionId: 'A', userId: 'alice', isAdmin: false };
const embedding = new TextOnlyEmbedding('q');
const rag = makeRag([]);
const store: OwnedRagStore = {
  name: 'history',
  owner: { scope: 'session', sessionId: 'A' },
  rag,
};

it('requires options.caller without querying the store', async () => {
  const result = await ownerBoundQuery(
    store,
    embedding,
    5,
    {},
    testRagAccess(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
  assert.equal(rag.queryCount, 0);
});

it('rejects a sessionId smuggled through ragFilter', async () => {
  const result = await ownerBoundQuery(
    store,
    embedding,
    5,
    { caller, ragFilter: { sessionId: 'B' } },
    testRagAccess(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
});

it('queries tools for any caller without a decision call', async () => {
  const access = testRagAccess();
  let calls = 0;
  access.decision.canRead = async () => {
    calls++;
    return false;
  };
  const result = await ownerBoundQuery(
    { ...store, name: 'tools', owner: { scope: 'internal' } },
    embedding,
    5,
    { caller },
    access,
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
});

for (const decision of ['deny', 'throw'] as const) {
  it(`RagOrchestrator fails closed when the read decision is ${decision}`, async () => {
    const access = testRagAccess();
    access.decision.canRead = async () => {
      if (decision === 'throw') throw new Error('decision unavailable');
      return false;
    };
    const result = await orchestrator(await sharedStore(), access).orchestrate(
      'record',
      {
        opts: { caller: callerA },
        sessionId: 'A',
        mode: 'hard',
        externalTools: [],
        rootSpan: new NoopTracer().startSpan('test'),
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
  });
}

it('an allow decision cannot widen another session owner', async () => {
  const result = await ownerBoundQuery(
    await sharedStore(),
    embedding,
    5,
    { caller: { ...callerA, sessionId: 'B' } },
    testRagAccess(),
  );
  assert.equal(result.ok, false);
});

for (const ragFilter of [{ userId: 'bob' }, { roleId: 'unassigned' }]) {
  it(`rejects a smuggled identity ${JSON.stringify(ragFilter)}`, async () => {
    const result = await ownerBoundQuery(
      store,
      embedding,
      5,
      { caller, ragFilter },
      testRagAccess(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
  });
}

it('role identity comes from the assignments table and foreign records stay closed', async () => {
  const access = testRagAccess();
  access.roles.rolesOf = async () => ({ ok: true, value: new Set(['reader']) });
  const roleStore: OwnedRagStore = {
    name: 'docs',
    owner: { scope: 'role', roleId: 'reader' },
    rag: makeRag([
      { text: 'own', metadata: { roleId: 'reader' }, score: 1 },
      { text: 'foreign', metadata: { roleId: 'other' }, score: 1 },
      { text: 'unowned', metadata: {}, score: 1 },
    ]),
  };
  const result = await ownerBoundQuery(
    roleStore,
    embedding,
    5,
    { caller },
    access,
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.map((record) => record.text),
    ['own'],
  );
  access.roles.rolesOf = async () => ({ ok: true, value: new Set() });
  assert.equal(
    (await ownerBoundQuery(roleStore, embedding, 5, { caller }, access)).ok,
    false,
  );
});

for (const decision of ['deny', 'throw'] as const) {
  it(`built-in history bypasses a ${decision} decision through RagOrchestrator`, async () => {
    const access = testRagAccess();
    let calls = 0;
    access.decision.canRead = async () => {
      calls++;
      if (decision === 'throw') throw new Error('decision unavailable');
      return false;
    };
    const history = { ...(await sharedStore()), builtIn: 'history' as const };
    const result = await orchestrator(history, access).orchestrate('record', {
      opts: { caller: callerA },
      sessionId: 'A',
      mode: 'hard',
      externalTools: [],
      rootSpan: new NoopTracer().startSpan('test'),
    });
    assert.ok(result.ok);
    assert.deepEqual(sessionTags(result.value.retrieved.ragResults.history), [
      'A',
    ]);
    assert.equal(calls, 0);
  });
}

it('ordinary session collections still require one server decision', async () => {
  const access = testRagAccess();
  let calls = 0;
  access.decision.canRead = async () => {
    calls++;
    return false;
  };
  const result = await ownerBoundQuery(
    await sharedStore(),
    embedding,
    5,
    { caller: callerA },
    access,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
  assert.equal(calls, 1);
});

for (const options of [
  {},
  { caller: { ...callerA, sessionId: 'B' } },
  { caller: callerA, ragFilter: { sessionId: 'B' } },
  { caller: callerA, ragFilter: { userId: 'bob' } },
  { caller: callerA, ragFilter: { roleId: 'unassigned' } },
]) {
  it(`built-in history rejects missing or foreign identity ${JSON.stringify(options)}`, async () => {
    const access = testRagAccess();
    let calls = 0;
    access.decision.canRead = async () => {
      calls++;
      return true;
    };
    const rag = makeRag([]);
    const result = await ownerBoundQuery(
      { ...store, builtIn: 'history', rag },
      embedding,
      5,
      options,
      access,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
    assert.equal(rag.queryCount, 0);
    assert.equal(calls, 0);
  });
}

it('global retrieval through RagOrchestrator drops session, user and role records from a shared in-memory store', async () => {
  const result = await orchestrator(await sharedGlobalStore()).orchestrate(
    'record',
    {
      opts: { caller: callerA },
      sessionId: 'A',
      mode: 'hard',
      externalTools: [],
      rootSpan: new NoopTracer().startSpan('test'),
    },
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.retrieved.ragResults.history.map((record) => record.text),
    ['record global'],
  );
});
