import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testRagAccess } from '../../testing/rag-access-testing.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { buildRagAdminToolEntries } from '../mcp-tools/index.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';

const names = [
  'rag_role_list',
  'rag_role_create',
  'rag_role_delete',
  'rag_role_assign',
  'rag_role_revoke',
  'rag_create_shared_collection',
];
function setup(isAdmin = true) {
  const registry = new SimpleRagRegistry();
  const providerRegistry = new SimpleRagProviderRegistry();
  const provider = new InMemoryRagProvider({
    name: 'mem',
    supportedScopes: ['role', 'global'],
  });
  providerRegistry.registerProvider(provider);
  registry.setProviderRegistry(providerRegistry);
  const access = {
    ...testRagAccess(),
    roles: provider.roles,
    bindings: provider.bindings,
  };
  const caller = { sessionId: 'S', userId: 'admin', isAdmin };
  const entries = buildRagAdminToolEntries({
    caller,
    access,
    registry,
    providerRegistry,
  });
  const tool = (name: string) => {
    const entry = entries.find((entry) => entry.toolDefinition.name === name);
    assert.ok(entry, name);
    return entry;
  };
  return { registry, access, caller, entries, tool };
}

describe('RAG admin tools', () => {
  it('returns no tools for non-admins, including direct dispatch', () => {
    const { entries } = setup(false);
    assert.equal(entries.length, 0);
    for (const name of names)
      assert.equal(
        entries.find((entry) => entry.toolDefinition.name === name),
        undefined,
      );
  });
  it('returns the six admin names in order', () => {
    assert.deepEqual(
      setup().entries.map((entry) => entry.toolDefinition.name),
      names,
    );
  });
  it('refuses deleting a role owning a collection and preserves the role', async () => {
    const { registry, access, tool } = setup();
    await access.roles.createRole({ roleId: 'R', name: 'Readers' });
    registry.register('docs', new InMemoryRag(), undefined, {
      displayName: 'docs',
      scope: 'role',
      roleId: 'R',
    });
    const result = await tool('rag_role_delete').handler({}, { roleId: 'R' });
    assert.match(JSON.stringify(result), /RoleInUseError/);
    const roles = await access.roles.listRoles();
    assert.ok(roles.ok);
    assert.equal(roles.value.length, 1);
  });
  it('refuses an unknown role when creating a shared collection', async () => {
    const { tool, registry } = setup();
    const result = await tool('rag_create_shared_collection').handler(
      {},
      {
        providerName: 'mem',
        collectionName: 'docs',
        scope: 'role',
        roleId: 'missing',
      },
    );
    assert.match(JSON.stringify(result), /RAG_ROLE_NOT_FOUND/);
    assert.equal(registry.list().length, 0);
  });
  it('manages roles and assignments through the library store', async () => {
    const { tool, access } = setup();
    await tool('rag_role_create').handler(
      {},
      { roleId: 'R', name: 'Readers', description: 'Read docs' },
    );
    await tool('rag_role_assign').handler({}, { roleId: 'R', userId: 'alice' });
    assert.deepEqual(await access.roles.rolesOf('alice'), {
      ok: true,
      value: new Set(['R']),
    });
    assert.match(
      JSON.stringify(await tool('rag_role_list').handler({}, {})),
      /Readers/,
    );
    await tool('rag_role_revoke').handler({}, { roleId: 'R', userId: 'alice' });
    assert.deepEqual(await access.roles.rolesOf('alice'), {
      ok: true,
      value: new Set(),
    });
    assert.deepEqual(
      await tool('rag_role_delete').handler({}, { roleId: 'R' }),
      { ok: true },
    );
  });
  for (const failure of ['deny', 'throw']) {
    it(`enforces the server decision for every admin tool: ${failure}`, async () => {
      const { tool, access, registry } = setup();
      const refuse = async () => {
        if (failure === 'throw') throw new Error('offline');
        return false;
      };
      access.decision.canRead = refuse;
      access.decision.canWrite = refuse;
      for (const name of names) {
        const result = await tool(name).handler(
          {},
          {
            roleId: 'R',
            userId: 'alice',
            name: 'Readers',
            providerName: 'mem',
            collectionName: 'docs',
            scope: 'global',
          },
        );
        assert.match(JSON.stringify(result), /RAG_ACCESS_DENIED/, name);
      }
      assert.deepEqual(await access.roles.listRoles(), { ok: true, value: [] });
      assert.equal(registry.list().length, 0);
    });
  }
  it('creates globals and requires assignment plus decision for role creation', async () => {
    const { tool, access, registry } = setup();
    const shared = tool('rag_create_shared_collection');
    await access.roles.createRole({ roleId: 'R', name: 'Readers' });
    const args = {
      providerName: 'mem',
      collectionName: 'docs',
      scope: 'role',
      roleId: 'R',
    };
    assert.match(
      JSON.stringify(await shared.handler({}, args)),
      /RAG_ACCESS_DENIED/,
    );
    await access.roles.assign('admin', 'R');
    assert.match(JSON.stringify(await shared.handler({}, args)), /"ok":true/);
    assert.match(
      JSON.stringify(await shared.handler({}, { ...args, scope: 'global' })),
      /"ok":true/,
    );
    assert.equal(registry.list().length, 2);
  });
});

describe('admin tool failure boundaries', () => {
  it('rejects owner smuggling and scopes outside shared collections', async () => {
    const { tool, registry } = setup();
    for (const extra of [
      { sessionId: 'other' },
      { userId: 'other' },
      { owner: { scope: 'global' } },
      { scope: 'session' },
    ]) {
      const result = await tool('rag_create_shared_collection').handler(
        {},
        {
          providerName: 'mem',
          collectionName: 'docs',
          scope: 'global',
          ...extra,
        },
      );
      assert.match(JSON.stringify(result), /Invalid admin tool arguments/);
    }
    assert.equal(registry.list().length, 0);
  });
  it('fails closed when role storage throws', async () => {
    const { tool, access, registry } = setup();
    access.roles.listRoles = async () => {
      throw new Error('unavailable');
    };
    for (const name of ['rag_role_list', 'rag_create_shared_collection']) {
      const result = await tool(name).handler(
        {},
        name === 'rag_role_list'
          ? {}
          : {
              providerName: 'mem',
              collectionName: 'docs',
              scope: 'role',
              roleId: 'R',
            },
      );
      assert.match(JSON.stringify(result), /RAG_ADMIN_ERROR/);
    }
    assert.equal(registry.list().length, 0);
  });
  it('checks the actual role collection decision even when admin management is allowed', async () => {
    const { tool, access, registry } = setup();
    await access.roles.createRole({ roleId: 'R', name: 'Readers' });
    await access.roles.assign('admin', 'R');
    access.decision.canWrite = async (_caller, ref) =>
      ref.owner.scope === 'global';
    const result = await tool('rag_create_shared_collection').handler(
      {},
      {
        providerName: 'mem',
        collectionName: 'docs',
        scope: 'role',
        roleId: 'R',
      },
    );
    assert.match(JSON.stringify(result), /RAG_ACCESS_DENIED/);
    assert.equal(registry.list().length, 0);
  });
  it('refuses a retained handler after the caller loses admin status', async () => {
    const { tool, caller, access } = setup();
    caller.isAdmin = false;
    const result = await tool('rag_role_create').handler(
      {},
      { roleId: 'R', name: 'Readers' },
    );
    assert.match(JSON.stringify(result), /RAG_ACCESS_DENIED/);
    assert.deepEqual(await access.roles.listRoles(), { ok: true, value: [] });
  });
});
