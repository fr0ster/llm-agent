import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RagCollectionOwner } from '../../interfaces/rag.js';
import {
  RagAccessDeniedError,
  type RagCaller,
} from '../../interfaces/rag-access.js';
import { RagError } from '../../interfaces/types.js';
import {
  fixedCallerResolver,
  testRagAccess,
} from '../../testing/rag-access-testing.js';
import { checkRagAccess, visibleOwnerFilter } from '../access/check-access.js';

const caller: RagCaller = { sessionId: 's1', userId: 'u1', isAdmin: false };
const session: RagCollectionOwner = { scope: 'session', sessionId: 's1' };
const user: RagCollectionOwner = { scope: 'user', userId: 'u1' };
const role: RagCollectionOwner = { scope: 'user', userId: 'foreign' };
const global: RagCollectionOwner = { scope: 'global' };

test('persisted binding is required without binding on read', async () => {
  const access = testRagAccess();
  const ref = { name: 'docs', owner: session };
  assert.equal((await checkRagAccess(caller, ref, 'read', access)).ok, false);
  assert.ok((await access.bindings.bind('s1', 'other')).ok);
  assert.equal((await checkRagAccess(caller, ref, 'read', access)).ok, false);
});

test('missing or invalid callers deny every scope before role lookup or decision', async () => {
  const access = testRagAccess([caller]);
  const owners: ReadonlyArray<RagCollectionOwner> = [
    global,
    session,
    user,
    role,
  ];
  let calls = 0;
  access.roles.rolesOf = async () => {
    calls++;
    return { ok: true, value: new Set(['r1']) };
  };
  access.decision.canRead = access.decision.canWrite = async () => {
    calls++;
    return true;
  };
  for (const identity of [
    undefined,
    null,
    {},
    'invalid',
    { ...caller, sessionId: undefined },
    { ...caller, userId: undefined },
    { ...caller, sessionId: 1 },
    { ...caller, userId: 1 },
    { ...caller, sessionId: '' },
    { ...caller, userId: '' },
    { ...caller, sessionId: '  ' },
    { ...caller, userId: '  ' },
  ]) {
    // @ts-expect-error Exercise malformed callers arriving from JavaScript.
    const visible = visibleOwnerFilter(identity);
    for (const owner of owners) {
      assert.equal(visible(owner), false);
      for (const mode of ['read', 'write'] as const) {
        const result = await checkRagAccess(
          // @ts-expect-error Exercise malformed callers arriving from JavaScript.
          identity,
          { name: 'docs', owner },
          mode,
          access,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
      }
    }
  }
  assert.equal(calls, 0);
});

test('same user sessions share user collections but isolate session collections; allowAllDecision never widens ownership', async () => {
  const access = testRagAccess([caller]);
  const cases: ReadonlyArray<
    readonly [RagCaller, RagCollectionOwner, boolean]
  > = [
    [caller, session, true],
    [{ ...caller, sessionId: 's2' }, session, false],
    [caller, user, true],
    [{ ...caller, sessionId: 's2' }, user, true],
    [{ ...caller, userId: 'u2', sessionId: 's2' }, user, false],
    [{ ...caller, userId: 'u2', sessionId: 's2' }, session, false],
    [{ ...caller, isAdmin: true, sessionId: 's2' }, session, false],
  ];
  for (const mode of ['read', 'write'] as const) {
    for (const [identity, owner, allowed] of cases) {
      const result = await checkRagAccess(
        identity,
        { name: 'docs', owner },
        mode,
        { ...access, bindings: testRagAccess([identity]).bindings },
      );
      assert.equal(result.ok, allowed);
      if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
    }
  }
});

test('role access follows library assignment and revocation on every request', async () => {
  const access = testRagAccess([caller]);
  const check = () =>
    checkRagAccess(caller, { name: 'docs', owner: role }, 'read', access);
  assert.equal((await check()).ok, false);
  assert.equal(
    (await access.roleAdmin.createRole({ roleId: 'r1', name: 'Team' })).ok,
    true,
  );
  assert.ok((await access.roleAdmin.bindCollection('docs', 'r1')).ok);
  assert.equal((await access.roleAdmin.assign('u1', 'r1')).ok, true);
  assert.equal((await check()).ok, true);
  assert.equal((await access.roleAdmin.revoke('u1', 'r1')).ok, true);
  assert.equal((await check()).ok, false);
});

test('global reads allow ownership; global writes require admin AND decision', async () => {
  const access = testRagAccess([caller]);
  const ref = { name: 'docs', owner: global };
  assert.equal((await checkRagAccess(caller, ref, 'read', access)).ok, true);
  assert.equal((await checkRagAccess(caller, ref, 'write', access)).ok, false);
  assert.equal(
    (await checkRagAccess({ ...caller, isAdmin: true }, ref, 'write', access))
      .ok,
    true,
  );
  for (const mode of ['read', 'write'] as const) {
    assert.equal(
      (
        await checkRagAccess({ ...caller, isAdmin: true }, ref, mode, {
          ...access,
          decision: { canRead: async () => false, canWrite: async () => false },
        })
      ).ok,
      false,
    );
  }
});

test('decision throw and role-store failure deny access', async () => {
  const access = testRagAccess([caller]);
  for (const mode of ['read', 'write'] as const) {
    const result = await checkRagAccess(
      caller,
      { name: 'docs', owner: user },
      mode,
      {
        ...access,
        decision: {
          canRead: async () => {
            throw new Error('boom');
          },
          canWrite: async () => {
            throw new Error('boom');
          },
        },
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error instanceof RagAccessDeniedError);
  }
  access.roles.rolesOf = async () => ({
    ok: false,
    error: new RagError('failed', 'FAILED'),
  });
  assert.equal(
    (
      await checkRagAccess(
        caller,
        { name: 'docs', owner: role },
        'read',
        access,
      )
    ).ok,
    false,
  );
  access.roles.rolesOf = async () => {
    throw new Error('boom');
  };
  assert.equal(
    (
      await checkRagAccess(
        caller,
        { name: 'docs', owner: role },
        'read',
        access,
      )
    ).ok,
    false,
  );
});

test('ownership denial skips the server decision', async () => {
  const access = testRagAccess([caller]);
  let calls = 0;
  access.decision.canRead = async () => {
    calls++;
    return true;
  };
  assert.equal(
    (
      await checkRagAccess(
        { ...caller, sessionId: 's2' },
        { name: 'docs', owner: session },
        'read',
        access,
      )
    ).ok,
    false,
  );
  assert.equal(calls, 0);
});

test('visibleOwnerFilter uses explicit identities and library roles', () => {
  const visible = visibleOwnerFilter(caller);
  for (const owner of [session, user, global])
    assert.equal(visible(owner), true);
  for (const owner of [
    { scope: 'session', sessionId: 's2' },
    { scope: 'user', userId: 'u2' },
  ] as const)
    assert.equal(visible(owner), false);
});

test('fixedCallerResolver returns a fresh fixed identity without session fallback', async () => {
  const identity = { userId: 'u1', isAdmin: false };
  const resolver = fixedCallerResolver(identity);
  identity.userId = 'changed';
  assert.deepEqual(await resolver.resolve('s2', { userId: 'u2' }), {
    ok: true,
    value: { userId: 'u1', isAdmin: false },
  });
});
