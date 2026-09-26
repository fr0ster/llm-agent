import type { ISecretLoginCredential } from '@mcp-abap-adt/interfaces-auth';

export interface HanaVectorRagConfig {
  /** The ADDRESS only. A string carrying credentials is refused below. */
  connectionString?: string;
  host?: string;
  port?: number;
  /**
   * Resolved at connect — a `HanaVectorRag` opens exactly one physical
   * connection, on first use, not a pool, so "once" and "per connection" are
   * the same thing here (a failed connect is retried on the next use, and
   * resolves it again) (contrast
   * `pg-vector-rag`, where a pool reuses one resolved value across many
   * physical connections unless the secret is handed over as a function).
   *
   * **Required**, unlike qdrant's and pg's `credential`. An unauthenticated
   * Qdrant is a real deployment, and Postgres falls back to trust auth or
   * `PGUSER`/`PGPASSWORD` — optional is correct for both. HANA has no
   * anonymous login: `resolveHanaConnectArgs` below throws unconditionally
   * when a user/password does not resolve, before and after this field
   * existed. The one HANA configuration that used to work without a discrete
   * `user`/`password` was a connection string carrying them
   * (`hdbsql://u:p@host`), and that path is refused on purpose (see
   * `connectionString` above) — so there is no longer a real, working HANA
   * configuration a required field here would refuse. Making it optional
   * would only move that same, unavoidable failure from a compile error to a
   * connect-time throw.
   */
  credential: ISecretLoginCredential;
  schema?: string;
  collectionName: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
}

export interface HanaConnectArgs {
  serverNode: string;
  uid: string;
  pwd: string;
  encrypt: 'true' | 'false';
  sslValidateCertificate?: 'true' | 'false';
  currentSchema?: string;
  communicationTimeout?: number;
}

export async function resolveHanaConnectArgs(
  cfg: HanaVectorRagConfig,
): Promise<HanaConnectArgs> {
  if (cfg.connectionString && /\/\/[^/@]*:[^/@]*@/.test(cfg.connectionString)) {
    throw new Error(
      'connectionString must carry the address only; pass the identity and secret as ' +
        'a credential — staticLogin(user, password)',
    );
  }

  let host = cfg.host;
  let port = cfg.port;

  if (cfg.connectionString) {
    const normalized = cfg.connectionString.replace(/^hdbsql:\/\//, 'https://');
    const u = new URL(normalized);
    host ??= u.hostname;
    port ??= u.port ? Number(u.port) : 443;
  }

  if (!host)
    throw new Error('HANA host is required (host or connectionString)');

  const user = cfg.credential.principal;
  const password = await cfg.credential.secret();

  if (!user) throw new Error('HANA user is required');
  if (!password) throw new Error('HANA password is required');

  return {
    serverNode: `${host}:${port ?? 443}`,
    uid: user,
    pwd: password,
    encrypt: 'true',
    sslValidateCertificate: 'true',
    currentSchema: cfg.schema,
    communicationTimeout: cfg.connectTimeout ?? 30_000,
  };
}
