import type { ISecretLoginCredential } from '@mcp-abap-adt/interfaces-auth';

export interface PgVectorRagConfig {
  /** The ADDRESS only. A string carrying credentials is refused below. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  /**
   * Asked for fresh on every connect — never cached — so a rotating
   * credential rotates and a resolved-once secret is never frozen for this
   * object's lifetime. Optional: a target that accepts trust/peer auth (or
   * PGUSER/PGPASSWORD from the environment) works today without one.
   */
  credential?: ISecretLoginCredential;
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

export async function resolvePgConnectArgs(
  cfg: PgVectorRagConfig,
): Promise<PgPoolConfig> {
  const max = cfg.poolMax ?? 10;
  const connectionTimeoutMillis = cfg.connectTimeout ?? 30_000;

  if (cfg.connectionString && /\/\/[^/@]*:[^/@]*@/.test(cfg.connectionString)) {
    throw new Error(
      'connectionString must carry the address only; pass the identity and secret as ' +
        'a credential — staticLogin(user, password)',
    );
  }

  const user = cfg.credential?.principal;
  const password = cfg.credential ? await cfg.credential.secret() : undefined;

  if (cfg.connectionString) {
    return {
      connectionString: cfg.connectionString,
      user,
      password,
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
    user,
    password,
    database: cfg.database,
    max,
    connectionTimeoutMillis,
  };
}
