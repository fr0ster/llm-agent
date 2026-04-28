import { RagError } from '@mcp-abap-adt/llm-agent';
const COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
export function assertCollectionName(name) {
    if (!COLLECTION_NAME_RE.test(name)) {
        throw new RagError(`Invalid collection name: ${name}`, 'INVALID_COLLECTION_NAME');
    }
}
export function quoteIdent(ident) {
    assertCollectionName(ident);
    return `"${ident}"`;
}
export function createTableSql(collection, dimension) {
    const table = quoteIdent(collection);
    return `CREATE TABLE IF NOT EXISTS ${table} (
    id NVARCHAR(255) PRIMARY KEY,
    text NCLOB,
    vector REAL_VECTOR(${dimension}),
    metadata NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
}
export function dropTableSql(collection) {
    return `DROP TABLE IF EXISTS ${quoteIdent(collection)}`;
}
//# sourceMappingURL=schema.js.map