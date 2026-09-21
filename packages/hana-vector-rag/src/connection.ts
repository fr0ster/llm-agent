import type { ISecretLoginCredential } from '@mcp-abap-adt/interfaces-auth';

export interface HanaVectorRagConfig {
  /** The ADDRESS only. A string carrying credentials is refused below. */
  connectionString?: string;
  host?: string;
  port?: number;
  /**
   * Asked for fresh on every connect — never cached — so a rotating
   * credential rotates and a resolved-once secret is never frozen for this
   * object's lifetime. Optional in the type, matching the discrete fields it
   * replaces, but the resolver below still requires a user and a password at
   * connect time — HANA has no anonymous login.
   */
  credential?: ISecretLoginCredential;
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

  const user = cfg.credential?.principal;
  const password = cfg.credential ? await cfg.credential.secret() : undefined;

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
