export interface PgVectorRagConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  collectionName: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
}

export interface PgPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max: number;
  connectionTimeoutMillis: number;
}

export function resolvePgConnectArgs(cfg: PgVectorRagConfig): PgPoolConfig {
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
