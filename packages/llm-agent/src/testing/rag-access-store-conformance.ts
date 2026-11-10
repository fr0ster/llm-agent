import assert from 'node:assert/strict';
import {
  type IRagRoleStore,
  type ISessionBindingStore,
  RoleInUseError,
  SessionBindingConflictError,
} from '../interfaces/rag-access.js';

export interface RagAccessStoreConformanceCase {
  readonly name: string;
  /** The factory must treat roleId `in-use` as owning a collection. Each call creates isolated stores. */
  run(
    make: () => Promise<{
      roles: IRagRoleStore;
      bindings: ISessionBindingStore;
    }>,
  ): Promise<void>;
}

export const ragAccessStoreConformanceCases: readonly RagAccessStoreConformanceCase[] =
  [
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
