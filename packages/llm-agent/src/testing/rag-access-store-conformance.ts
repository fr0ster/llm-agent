import assert from 'node:assert/strict';
import type {
  IRagRoleAdmin,
  IRagRoleCheck,
  ISessionBindingStore,
} from '../interfaces/rag-access.js';
import { RoleInUseError } from '../interfaces/rag-access.js';
import type { RagError, Result } from '../interfaces/types.js';
import { checkRagAccess } from '../rag/access/check-access.js';

export interface RagAccessStoreHarness {
  roles: IRagRoleCheck;
  roleAdmin: IRagRoleAdmin;
  bindings: ISessionBindingStore;
  independentStores(): Promise<{
    roles: IRagRoleCheck;
    roleAdmin: IRagRoleAdmin;
    bindings: ISessionBindingStore;
  }>;
  deleteCollection(name: string): Promise<Result<void, RagError>>;
  createCollection(name: string): Promise<Result<void, RagError>>;
}
export interface RagAccessStoreConformanceCase {
  readonly name: string;
  run(make: () => Promise<RagAccessStoreHarness>): Promise<void>;
}
export const ragAccessStoreConformanceCases: readonly RagAccessStoreConformanceCase[] =
  [
    {
      name: 'one owner and several bound roles with live revocation',
      async run(make) {
        const h = await make();
        const owner = {
          sessionId: 'owner-session',
          userId: 'owner',
          isAdmin: false,
        };
        const reader = {
          sessionId: 'reader-session',
          userId: 'reader',
          isAdmin: false,
        };
        const outsider = {
          sessionId: 'other-session',
          userId: 'other',
          isAdmin: true,
        };
        for (const caller of [owner, reader, outsider])
          assert.ok(
            (await h.bindings.bind(caller.sessionId, caller.userId)).ok,
          );
        assert.ok((await h.createCollection('docs')).ok);
        for (const roleId of ['team', 'reviewers']) {
          assert.ok(
            (await h.roleAdmin.createRole({ roleId, name: roleId })).ok,
          );
          assert.ok((await h.roleAdmin.bindCollection('docs', roleId)).ok);
        }
        assert.ok((await h.roleAdmin.assign(reader.userId, 'reviewers')).ok);
        const ref = {
          name: 'docs',
          owner: { scope: 'user' as const, userId: owner.userId },
        };
        const access = {
          ...h,
          decision: { canRead: async () => true, canWrite: async () => true },
        };
        assert.ok((await checkRagAccess(owner, ref, 'read', access)).ok);
        assert.ok((await checkRagAccess(reader, ref, 'read', access)).ok);
        assert.equal(
          (await checkRagAccess(outsider, ref, 'read', access)).ok,
          false,
        );
        assert.ok((await h.roleAdmin.revoke(reader.userId, 'reviewers')).ok);
        assert.equal(
          (await checkRagAccess(reader, ref, 'read', access)).ok,
          false,
        );
        assert.ok((await h.roleAdmin.assign(reader.userId, 'reviewers')).ok);
        assert.ok((await h.roleAdmin.unbindCollection('docs', 'reviewers')).ok);
        assert.equal(
          (await checkRagAccess(reader, ref, 'read', access)).ok,
          false,
        );
        assert.equal(
          (
            await checkRagAccess(owner, ref, 'read', {
              ...access,
              decision: { ...access.decision, canRead: async () => false },
            })
          ).ok,
          false,
        );
      },
    },
    {
      name: 'refuse missing bindings and deletion of assigned or bound roles',
      async run(make) {
        const h = await make();
        assert.ok((await h.createCollection('docs')).ok);
        assert.equal(
          (await h.roleAdmin.bindCollection('docs', 'missing')).ok,
          false,
        );
        assert.ok(
          (await h.roleAdmin.createRole({ roleId: 'r', name: 'R' })).ok,
        );
        assert.equal(
          (await h.roleAdmin.bindCollection('missing', 'r')).ok,
          false,
        );
        assert.ok((await h.roleAdmin.assign('reader', 'r')).ok);
        let deletion = await h.roleAdmin.deleteRole('r');
        assert.equal(deletion.ok, false);
        if (!deletion.ok) assert.ok(deletion.error instanceof RoleInUseError);
        assert.ok((await h.roleAdmin.revoke('reader', 'r')).ok);
        assert.ok((await h.roleAdmin.bindCollection('docs', 'r')).ok);
        deletion = await h.roleAdmin.deleteRole('r');
        assert.equal(deletion.ok, false);
        if (!deletion.ok) assert.ok(deletion.error instanceof RoleInUseError);
        assert.ok((await h.roleAdmin.unbindCollection('docs', 'r')).ok);
        assert.ok((await h.roleAdmin.deleteRole('r')).ok);
      },
    },
    {
      name: 'binding and role deletion cannot both succeed concurrently',
      async run(make) {
        const h = await make();
        assert.ok((await h.createCollection('race_docs')).ok);
        for (let index = 0; index < 8; index++) {
          const roleId = `race-${index}`;
          assert.ok(
            (await h.roleAdmin.createRole({ roleId, name: roleId })).ok,
          );
          const [binding, deletion] = await Promise.all([
            h.roleAdmin.bindCollection('race_docs', roleId),
            h.roleAdmin.deleteRole(roleId),
          ]);
          assert.equal(binding.ok && deletion.ok, false);
          const roles = await h.roles.collectionRoles('race_docs');
          assert.ok(roles.ok);
          if (deletion.ok) assert.equal(roles.value.has(roleId), false);
          if (binding.ok) {
            assert.ok(roles.value.has(roleId));
            const refused = await h.roleAdmin.deleteRole(roleId);
            assert.equal(refused.ok, false);
            if (!refused.ok) assert.ok(refused.error instanceof RoleInUseError);
          }
        }
      },
    },
    {
      name: 'session bindings are immutable and concurrent stores agree',
      async run(make) {
        const h = await make();
        const other = await h.independentStores();
        assert.notEqual(other.bindings, h.bindings);
        const results = await Promise.all([
          h.bindings.bind('concurrent-session', 'first-user'),
          other.bindings.bind('concurrent-session', 'second-user'),
        ]);
        assert.equal(results.filter((result) => result.ok).length, 1);
        const stored = await h.bindings.getUserId('concurrent-session');
        assert.ok(stored.ok);
        assert.equal(
          stored.value,
          results[0].ok ? 'first-user' : 'second-user',
        );
        assert.ok(
          (await other.bindings.bind('concurrent-session', stored.value ?? ''))
            .ok,
        );
        assert.deepEqual(
          await other.bindings.getUserId('concurrent-session'),
          stored,
        );
      },
    },
    {
      name: 'role lifecycle isolates users, rejects missing assignments and removes deleted assignments',
      async run(make) {
        const h = await make();
        assert.equal((await h.roleAdmin.assign('alice', 'missing')).ok, false);
        for (const roleId of ['a', 'b'])
          assert.ok(
            (await h.roleAdmin.createRole({ roleId, name: roleId })).ok,
          );
        assert.equal(
          (await h.roleAdmin.createRole({ roleId: 'a', name: 'Duplicate' })).ok,
          false,
        );
        assert.ok((await h.roleAdmin.assign('alice', 'a')).ok);
        assert.ok((await h.roleAdmin.assign('alice', 'a')).ok);
        for (const user of ['alice', 'bob'])
          assert.ok((await h.roleAdmin.assign(user, 'a')).ok);
        assert.ok((await h.roleAdmin.assign('alice', 'b')).ok);
        assert.deepEqual(await h.roles.rolesOf('alice'), {
          ok: true,
          value: new Set(['a', 'b']),
        });
        assert.deepEqual(await h.roles.rolesOf('bob'), {
          ok: true,
          value: new Set(['a']),
        });
        assert.deepEqual(await h.roles.rolesOf('outsider'), {
          ok: true,
          value: new Set(),
        });
        assert.equal((await h.roleAdmin.deleteRole('a')).ok, false);
        assert.ok((await h.roleAdmin.revoke('alice', 'a')).ok);
        assert.ok((await h.roleAdmin.revoke('alice', 'a')).ok);
        assert.ok((await h.roleAdmin.revoke('bob', 'a')).ok);
        assert.ok((await h.roleAdmin.deleteRole('a')).ok);
        assert.ok(
          (await h.roleAdmin.createRole({ roleId: 'a', name: 'Recreated' })).ok,
        );
        assert.deepEqual(await h.roles.rolesOf('alice'), {
          ok: true,
          value: new Set(['b']),
        });
        assert.deepEqual(await h.roles.rolesOf('bob'), {
          ok: true,
          value: new Set(),
        });
        assert.ok((await h.roleAdmin.revoke('alice', 'b')).ok);
        assert.ok((await h.roleAdmin.deleteRole('a')).ok);
        assert.ok((await h.roleAdmin.deleteRole('b')).ok);
        assert.deepEqual(await h.roleAdmin.listRoles(), {
          ok: true,
          value: [],
        });
      },
    },
    ...[false, true].map((race) => ({
      name: race
        ? 'collection deletion racing binding leaves no inherited grants'
        : 'deleted and recreated collection denies the previous role holder',
      async run(make: () => Promise<RagAccessStoreHarness>) {
        const h = await make();
        const other = await h.independentStores();
        assert.ok((await h.createCollection('recreated')).ok);
        assert.ok(
          (await h.roleAdmin.createRole({ roleId: 'reader', name: 'Reader' }))
            .ok,
        );
        assert.ok((await h.roleAdmin.assign('reader', 'reader')).ok);
        assert.ok((await h.bindings.bind('reader-session', 'reader')).ok);
        if (race) {
          const [, deletion] = await Promise.all([
            other.roleAdmin.bindCollection('recreated', 'reader'),
            h.deleteCollection('recreated'),
          ]);
          assert.ok(deletion.ok);
        } else {
          assert.ok(
            (await other.roleAdmin.bindCollection('recreated', 'reader')).ok,
          );
          assert.ok((await h.deleteCollection('recreated')).ok);
        }
        assert.deepEqual(await other.roles.collectionRoles('recreated'), {
          ok: true,
          value: new Set(),
        });
        assert.ok((await h.createCollection('recreated')).ok);
        const result = await checkRagAccess(
          { sessionId: 'reader-session', userId: 'reader', isAdmin: false },
          { name: 'recreated', owner: { scope: 'user', userId: 'owner' } },
          'read',
          {
            ...h,
            decision: { canRead: async () => true, canWrite: async () => true },
          },
        );
        assert.equal(result.ok, false);
        assert.ok((await h.roleAdmin.revoke('reader', 'reader')).ok);
        assert.ok((await h.roleAdmin.deleteRole('reader')).ok);
      },
    })),
  ];
