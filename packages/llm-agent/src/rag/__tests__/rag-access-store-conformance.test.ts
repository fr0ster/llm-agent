import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ragAccessStoreConformanceCases } from '../../testing/rag-access-store-conformance.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';

for (const entry of ragAccessStoreConformanceCases) {
  test(entry.name, () =>
    entry.run(async () => {
      const provider = new InMemoryRagProvider({
        name: 'memory',
        supportedScopes: ['role'],
      });
      return {
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
          deleteRole: (id) => provider.roles.deleteRole(id),
          assign: (user, role) => provider.roles.assign(user, role),
          revoke: (user, role) => provider.roles.revoke(user, role),
          rolesOf: (user) => provider.roles.rolesOf(user),
        },
        bindings: provider.bindings,
        async createRoleCollection(roleId) {
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
