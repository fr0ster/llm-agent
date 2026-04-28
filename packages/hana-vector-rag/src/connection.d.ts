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
export declare function resolveHanaConnectArgs(cfg: HanaVectorRagConfig): HanaConnectArgs;
//# sourceMappingURL=connection.d.ts.map