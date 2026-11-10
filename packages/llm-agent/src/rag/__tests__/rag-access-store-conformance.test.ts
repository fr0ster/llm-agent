import { test } from 'node:test';
import { ragAccessStoreConformanceCases } from '../../testing/rag-access-store-conformance.js';
import { InMemoryRagRoleStore } from '../access/in-memory-role-store.js';
import { InMemorySessionBindingStore } from '../access/in-memory-session-binding-store.js';

for (const entry of ragAccessStoreConformanceCases) {
  test(entry.name, () =>
    entry.run(async () => ({
      roles: new InMemoryRagRoleStore((roleId) => roleId === 'in-use'),
      bindings: new InMemorySessionBindingStore(),
    })),
  );
}
