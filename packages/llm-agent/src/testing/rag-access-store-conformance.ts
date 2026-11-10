import assert from 'node:assert/strict';
import type { RagCollectionRecord } from '../interfaces/rag.js';
import {
  type IRagRoleStore,
  type ISessionBindingStore,
  RoleInUseError,
  SessionBindingConflictError,
} from '../interfaces/rag-access.js';
import type { RagError, Result } from '../interfaces/types.js';

/** Optional step points must run before acquiring the backend transaction lock. */
export type RagAccessBarrierHook = (
  operation: 'creation' | 'deletion',
) => Promise<void>;

export interface RagAccessStoreHarness {
  roles: IRagRoleStore;
  bindings: ISessionBindingStore;
  createRoleCollection(roleId: string): Promise<Result<void, RagError>>;
  collections(): Promise<readonly RagCollectionRecord[]>;
  /** Install a backend-specific gate; omit to exercise concurrent Promise.all instead. */
  setBarrierHook?: (hook: RagAccessBarrierHook) => void;
}

export interface RagAccessStoreConformanceCase {
  readonly name: string;
  /** Each call creates isolated stores, with roleId `in-use` treated as owning a collection. */
  run(make: () => Promise<RagAccessStoreHarness>): Promise<void>;
}

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export const ragAccessStoreConformanceCases: readonly RagAccessStoreConformanceCase[] =
  [
    {
      name: 'creating a role-owned catalog record for a missing role is refused',
      async run(make) {
        const h = await make();
        assert.equal((await h.createRoleCollection('missing')).ok, false);
        assert.equal(
          (await h.collections()).some(
            (r) => r.scope === 'role' && r.roleId === 'missing',
          ),
          false,
        );
      },
    },
    ...(['creation', 'deletion'] as const).map(
      (first): RagAccessStoreConformanceCase => ({
        name: `role deletion and collection creation interleaved: ${first} first never leaves an orphan`,
        async run(make) {
          const h = await make();
          assert.ok(
            (await h.roles.createRole({ roleId: 'race', name: 'Race' })).ok,
          );
          assert.ok((await h.roles.assign('race-user', 'race')).ok);
          const entered = barrier();
          const resume = barrier();
          const blocked = first === 'creation' ? 'deletion' : 'creation';
          h.setBarrierHook?.(async (operation) => {
            if (operation === blocked) {
              entered.release();
              await resume.promise;
            }
          });
          let creationSucceeded = false;
          let deletionSucceeded = false;
          const create = async () => {
            const result = await h.createRoleCollection('race');
            creationSucceeded = result.ok;
            return result;
          };
          const remove = async () => {
            const result = await h.roles.deleteRole('race');
            deletionSucceeded = result.ok;
            return result;
          };
          try {
            if (h.setBarrierHook) {
              const waiting = blocked === 'creation' ? create() : remove();
              await entered.promise;
              try {
                assert.ok(
                  (await (first === 'creation' ? create() : remove())).ok,
                );
              } finally {
                resume.release();
              }
              assert.equal((await waiting).ok, false);
            } else {
              const results = await Promise.all(
                first === 'creation'
                  ? [create(), remove()]
                  : [remove(), create()],
              );
              assert.equal(
                results.every((r) => r.ok),
                false,
              );
            }
            assert.equal(
              creationSucceeded && deletionSucceeded,
              false,
              'competing operations cannot both succeed',
            );
            const collections = await h.collections();
            assert.equal(
              collections.some(
                (record) => record.scope === 'role' && record.roleId === 'race',
              ),
              creationSucceeded,
            );
            const assignments = await h.roles.rolesOf('race-user');
            assert.ok(assignments.ok);
            assert.equal(assignments.value.has('race'), creationSucceeded);
            const roles = await h.roles.listRoles();
            assert.ok(roles.ok);
            for (const record of collections)
              if (record.scope === 'role' && record.roleId === 'race')
                assert.ok(
                  roles.value.some((role) => role.roleId === record.roleId),
                  'collection must retain its role',
                );
          } finally {
            resume.release();
          }
        },
      }),
    ),
    {
      name: "bind('s','u1') twice is ok",
      async run(make) {
        const { bindings } = await make();
        assert.equal((await bindings.bind('s', 'u1')).ok, true);
        assert.equal((await bindings.bind('s', 'u1')).ok, true);
      },
    },
    {
      name: "bind('s','u2') returns SessionBindingConflictError",
      async run(make) {
        const { bindings } = await make();
        assert.equal((await bindings.bind('s', 'u1')).ok, true);
        const result = await bindings.bind('s', 'u2');
        assert.equal(result.ok, false);
        if (!result.ok)
          assert.ok(result.error instanceof SessionBindingConflictError);
        assert.equal((await bindings.bind('s', 'u1')).ok, true);
      },
    },
    {
      name: "Promise.all([bind('s','u1'), bind('s','u2')]) gives exactly one ok",
      async run(make) {
        const { bindings } = await make();
        const results = await Promise.all([
          bindings.bind('s', 'u1'),
          bindings.bind('s', 'u2'),
        ]);
        assert.equal(results.filter((result) => result.ok).length, 1);
        for (const result of results)
          if (!result.ok)
            assert.ok(result.error instanceof SessionBindingConflictError);
        const winner = results[0].ok ? 'u1' : 'u2';
        assert.equal((await bindings.bind('s', winner)).ok, true);
      },
    },
    {
      name: 'deleteRole of a role in use returns RoleInUseError',
      async run(make) {
        const { roles } = await make();
        assert.equal(
          (await roles.createRole({ roleId: 'in-use', name: 'Used' })).ok,
          true,
        );
        assert.equal((await roles.assign('u1', 'in-use')).ok, true);
        const result = await roles.deleteRole('in-use');
        assert.equal(result.ok, false);
        if (!result.ok) assert.ok(result.error instanceof RoleInUseError);
        const assigned = await roles.rolesOf('u1');
        assert.ok(assigned.ok);
        assert.equal(assigned.value.has('in-use'), true);
      },
    },
    {
      name: 'role lifecycle isolates users, rejects missing assignments and removes deleted assignments',
      async run(make) {
        const { roles } = await make();
        assert.equal((await roles.assign('u1', 'r1')).ok, false);
        assert.equal(
          (
            await roles.createRole({
              roleId: 'r1',
              name: 'Team',
              description: 'Example',
            })
          ).ok,
          true,
        );
        assert.equal(
          (await roles.createRole({ roleId: 'r1', name: 'Duplicate' })).ok,
          false,
        );
        assert.equal((await roles.assign('u1', 'r1')).ok, true);
        assert.equal((await roles.assign('u1', 'r1')).ok, true);
        const assigned = await roles.rolesOf('u1');
        assert.ok(assigned.ok);
        assert.deepEqual([...assigned.value], ['r1']);
        const other = await roles.rolesOf('u2');
        assert.ok(other.ok);
        assert.equal(other.value.size, 0);
        assert.equal((await roles.revoke('u1', 'r1')).ok, true);
        assert.equal((await roles.revoke('u1', 'r1')).ok, true);
        assert.equal((await roles.assign('u1', 'r1')).ok, true);
        assert.equal((await roles.deleteRole('r1')).ok, true);
        const remaining = await roles.rolesOf('u1');
        assert.ok(remaining.ok);
        assert.equal(remaining.value.size, 0);
        assert.deepEqual(await roles.listRoles(), { ok: true, value: [] });
      },
    },
  ];
