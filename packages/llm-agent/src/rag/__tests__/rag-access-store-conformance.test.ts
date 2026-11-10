import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ragAccessStoreConformanceCases } from '../../testing/rag-access-store-conformance.js';
import { missingRoleMigrationConformanceCase } from '../../testing/rag-migration-conformance.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';

for (const entry of ragAccessStoreConformanceCases) {
  test(entry.name, () =>
    entry.run(async () => {
      const provider = new InMemoryRagProvider({
        name: 'memory',
        supportedScopes: ['role'],
      });
      let raceHooks = {
        deletionPaused: async () => {},
        creationPaused: async () => {},
      };
      return {
        deletionSerializesCreation: true,
        setDeletionRaceHooks(hooks) {
          raceHooks = hooks;
        },
        async rawCatalogRoleIds() {
          const result = await provider.describeCollections();
          assert.ok(result.ok);
          return result.value.records.flatMap((r) =>
            r.scope === 'role' ? [r.roleId] : [],
          );
        },
        async rawAssignmentRoleIds() {
          const result = await provider.roles.rolesOf('u');
          assert.ok(result.ok);
          return [...result.value];
        },
        roles: {
          listRoles: () => provider.roles.listRoles(),
          async createRole(role) {
            const result = await provider.roles.createRole(role);
            if (result.ok && role.roleId === 'in-use')
              assert.ok(
                (
                  await provider.createCollection('used', {
                    scope: 'role',
                    roleId: role.roleId,
                  })
                ).ok,
              );
            return result;
          },
          deleteRole: async (id) => {
            await raceHooks.deletionPaused();
            return provider.roles.deleteRole(id);
          },
          assign: (user, role) => provider.roles.assign(user, role),
          revoke: (user, role) => provider.roles.revoke(user, role),
          rolesOf: (user) => provider.roles.rolesOf(user),
        },
        bindings: provider.bindings,
        async createRoleCollection(roleId) {
          await raceHooks.creationPaused();
          const result = await provider.createCollection(`docs_${roleId}`, {
            scope: 'role',
            roleId,
          });
          return result.ok ? { ok: true, value: undefined } : result;
        },
        async collections() {
          const result = await provider.describeCollections();
          assert.ok(result.ok);
          return result.value.records;
        },
      };
    }),
  );
}

test(`In-memory ${missingRoleMigrationConformanceCase.name}`, async (t) => {
  const provider = new InMemoryRagProvider({
    name: 'memory',
    supportedScopes: ['role'],
  });
  await missingRoleMigrationConformanceCase.run({
    async seedMissingRole() {
      assert.ok(
        (await provider.roles.createRole({ roleId: 'missing', name: 'Role' }))
          .ok,
      );
      assert.ok(
        (
          await provider.createCollection('orphan', {
            scope: 'role',
            roleId: 'missing',
          })
        ).ok,
      );
      // Simulate a legacy orphan without bypassing the public deletion guard.
      t.mock.method(provider.roles, 'hasRole', () => false);
    },
    async migrate() {
      const description = await provider.describeCollections();
      assert.ok(description.ok);
      return {
        ok: true,
        value: {
          reported: description.value.rejected.map((row) => {
            assert.ok(row.storeName);
            return { storeName: row.storeName, reason: row.reason };
          }),
        },
      };
    },
    describe: () => provider.describeCollections(),
  });
});
