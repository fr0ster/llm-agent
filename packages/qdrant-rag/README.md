# @mcp-abap-adt/qdrant-rag

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

QdrantRag vector store and QdrantRagProvider for @mcp-abap-adt/llm-agent.

Provides vector search capabilities using Qdrant as the backend.

## Catalog, rights, and the Qdrant version

`QdrantRagProvider` keeps one record per collection in a catalog collection of its own
(`rag_collection_catalog` by default, `catalogCollection` to rename it): one point per collection,
the record in its payload. `createCollection` embeds one probe string to learn the vector size,
creates the collection, and then writes its record; `deleteCollection` deletes the record first, then
the collection; `describeCollections` reads the catalog back.

- **Qdrant 1.17 or later is required** for a catalogued store: the record is written with
  `update_mode: "insert_only"`, which exists from 1.17.
- **The key must be able to manage collections**: create collections (the catalog on first use, one
  per collection), write, read and delete points in the catalog, and delete collections. A
  `read-only-api-key`, or a JWT restricted to named collections, is not enough.
- A standalone `QdrantRag` (a store configured directly, not through the provider) keeps creating
  its collection on the first write (`autoCreateCollection`, default `true`); the provider's handles
  never create theirs.

A collection created before this release has a collection and no record: take it over once with
`createCollection(..., { adoptExisting: true })`.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
