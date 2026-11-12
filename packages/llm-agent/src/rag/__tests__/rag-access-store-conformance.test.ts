import { test } from 'node:test';
import { ragAccessStoreConformanceCases } from '../../testing/rag-access-store-conformance.js';
import { InMemorySessionBindingStore } from '../access/in-memory-session-binding-store.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';

for (const item of ragAccessStoreConformanceCases) {
  test(`memory ${item.name}`, async () =>
    item.run(async () => {
      const provider = new InMemoryRagProvider({
        name: 'test',
        supportedScopes: ['user'],
      });
      const bindings = new Map<string, string>();
      return {
        independentStores: async () => ({
          roles: {
            rolesOf: (user) => provider.roles.rolesOf(user),
            collectionRoles: (name) => provider.roles.collectionRoles(name),
          },
          roleAdmin: provider.roleAdmin,
          bindings: new InMemorySessionBindingStore([], bindings),
        }),
        deleteCollection: (name) => provider.deleteCollection(name),
        roles: provider.roles,
        roleAdmin: provider.roleAdmin,
        bindings: new InMemorySessionBindingStore([], bindings),
        async createCollection(name) {
          const result = await provider.createCollection(name, {
            scope: 'user',
            userId: 'owner',
          });
          return result.ok ? { ok: true, value: undefined } : result;
        },
      };
    }));
}
