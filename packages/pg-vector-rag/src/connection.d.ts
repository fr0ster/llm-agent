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
export declare function resolvePgConnectArgs(
  cfg: PgVectorRagConfig,
): PgPoolConfig;
//# sourceMappingURL=connection.d.ts.map
