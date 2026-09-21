import type { ISecretLoginCredential } from '@mcp-abap-adt/interfaces-auth';

export interface PgVectorRagConfig {
  /** The ADDRESS only. A string carrying credentials is refused below. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  /**
   * The password half is handed to `pg` as a function (see
   * `resolvePgConnectArgs` below), not resolved to a string here — a
   * `PgVectorRag`'s pool reuses one config object for every physical
   * connection it opens over its lifetime, so a string resolved once would
   * freeze a rotating credential for as long as the pool lives. `principal`
   * (the identity) is read once: it does not rotate.
   *
   * Optional: a target that accepts trust/peer auth (or PGUSER/PGPASSWORD
   * from the environment) works today without one.
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
  /**
   * A function, not a resolved string, when a `credential` was given: `pg`
   * (both the published types, `@types/pg`'s
   * `password?: string | (() => string | Promise<string>)`, and the
   * installed runtime, which checks `typeof this.password === 'function'`
   * per client in `lib/client.js`) calls this once per physical connection
   * it opens — which is what makes a rotating credential actually rotate
   * across the pool's lifetime, not just across pool *construction*.
   */
  password?: string | (() => string | Promise<string>);
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

  const credential = cfg.credential;
  const user = credential?.principal;
  // Handed to `pg` as the function itself, deliberately not awaited here —
  // resolving it now would bake today's value into the pool's config object,
  // which `pg` then reuses for every physical connection it opens for as
  // long as the pool lives. Passing the function lets `pg` call it fresh
  // per connection, so a rotating credential actually rotates.
  const password = credential ? () => credential.secret() : undefined;

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
