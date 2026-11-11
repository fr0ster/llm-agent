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
      'user_id NVARCHAR(500) NOT NULL, role_id NVARCHAR(500) NOT NULL, PRIMARY KEY (user_id, role_id), FOREIGN KEY (role_id) REFERENCES "rag_roles" (role_id)',
  },
  {
    name: 'rag_session_bindings',
    definition:
      'session_id NVARCHAR(500) PRIMARY KEY, user_id NVARCHAR(500) NOT NULL',
  },
] as const;
