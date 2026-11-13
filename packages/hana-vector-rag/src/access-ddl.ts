/** Access tables shared by the runtime migration and HDI artifacts. */
export const accessTables = [
  {
    name: 'rag_roles',
    definition:
      'role_id NVARCHAR(500) PRIMARY KEY, name NVARCHAR(5000) NOT NULL, description NVARCHAR(5000)',
  },
  {
    name: 'rag_role_assignments',
    definition:
      'user_id NVARCHAR(500) NOT NULL, role_id NVARCHAR(500) NOT NULL, PRIMARY KEY (user_id, role_id)',
  },
  {
    name: 'rag_collection_roles',
    definition:
      'collection_name NVARCHAR(500) NOT NULL, role_id NVARCHAR(500) NOT NULL, PRIMARY KEY (collection_name, role_id)',
  },

  {
    name: 'rag_session_bindings',
    definition:
      'session_id NVARCHAR(500) PRIMARY KEY, user_id NVARCHAR(500) NOT NULL',
  },
] as const;

/** Quoted uppercase columns match HANA's unquoted column identifiers. */
export const accessForeignKeys = [
  {
    name: 'rag_role_assignments_role_fk',
    table: 'rag_role_assignments',
    column: 'ROLE_ID',
    referencedTable: 'rag_roles',
    referencedColumn: 'ROLE_ID',
  },
  {
    name: 'rag_collection_roles_role_fk',
    table: 'rag_collection_roles',
    column: 'ROLE_ID',
    referencedTable: 'rag_roles',
    referencedColumn: 'ROLE_ID',
  },
] as const;

type AccessForeignKey = (typeof accessForeignKeys)[number];

function foreignKeyClause(key: AccessForeignKey): string {
  return `FOREIGN KEY ("${key.column}") REFERENCES "${key.referencedTable}" ("${key.referencedColumn}")`;
}

export function accessForeignKeyHdbconstraint(key: AccessForeignKey): string {
  return `CONSTRAINT "${key.name}" ON "${key.table}" ${foreignKeyClause(key)}`;
}

/** Runtime CREATE TABLE body, including the same named foreign keys as HDI. */
export function accessTableRuntimeDefinition(
  table: (typeof accessTables)[number],
): string {
  return [
    table.definition,
    ...accessForeignKeys
      .filter((key) => key.table === table.name)
      .map((key) => `CONSTRAINT "${key.name}" ${foreignKeyClause(key)}`),
  ].join(', ');
}
