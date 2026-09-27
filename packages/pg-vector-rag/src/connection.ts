import type { ISecretLoginCredential } from '@mcp-abap-adt/interfaces-auth';
import { parse as parseConnectionString } from 'pg-connection-string';

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
  /** The rest of a connection string's settings (`ssl`, `options`, …), as pg parses them. */
  [setting: string]: unknown;
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
    // Parsed here, NOT handed to pg as `connectionString`: pg merges the parsed
    // string OVER the config, and a URL without userinfo parses to user "" and
    // password "" — which silently replaced the credential, so the pool
    // connected as the OS user with no password. The same parser pg uses, so
    // every setting the string carries (ssl, options, …) still applies.
    const {
      user: _user,
      password: _password,
      port,
      host,
      database,
      ...settings
    } = parseConnectionString(cfg.connectionString);
    return {
      ...settings,
      host: host ?? undefined,
      port: port ? Number(port) : undefined,
      database: database ?? undefined,
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
