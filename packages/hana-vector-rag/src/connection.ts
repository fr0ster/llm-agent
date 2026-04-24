export interface HanaVectorRagConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
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

export function resolveHanaConnectArgs(
  cfg: HanaVectorRagConfig,
): HanaConnectArgs {
  let host = cfg.host;
  let port = cfg.port;
  let user = cfg.user;
  let password = cfg.password;

  if (cfg.connectionString) {
    const normalized = cfg.connectionString.replace(/^hdbsql:\/\//, 'https://');
    const u = new URL(normalized);
    host ??= u.hostname;
    port ??= u.port ? Number(u.port) : 443;
    user ??= decodeURIComponent(u.username);
    password ??= decodeURIComponent(u.password);
  }

  if (!host)
    throw new Error('HANA host is required (host or connectionString)');
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
