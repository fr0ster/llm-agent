export function resolvePgConnectArgs(cfg) {
  const max = cfg.poolMax ?? 10;
  const connectionTimeoutMillis = cfg.connectTimeout ?? 30_000;
  if (cfg.connectionString) {
    return {
      connectionString: cfg.connectionString,
      max,
      connectionTimeoutMillis,
    };
  }
  if (!cfg.host) {
    throw new Error('Postgres connectionString or host is required');
  }
  return {
    host: cfg.host,
    port: cfg.port ?? 5432,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max,
    connectionTimeoutMillis,
  };
}
//# sourceMappingURL=connection.js.map
