# @mcp-abap-adt/hana-vector-rag

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

SAP HANA Cloud Vector Engine backend for [@mcp-abap-adt/llm-agent](https://www.npmjs.com/package/@mcp-abap-adt/llm-agent).

Provides:
- `HanaVectorRag` — `IRag` implementation backed by `REAL_VECTOR(dim)` columns.
- `HanaVectorRagProvider` — `IRagProvider` for session/user/global collections.

## Install

```bash
npm install @mcp-abap-adt/hana-vector-rag @sap/hana-client
```

## Minimal config

```yaml
rag:
  type: hana-vector
  connectionString: hdbsql://user:pass@host:443
  collectionName: llm_agent_docs
  dimension: 1536
  autoCreateSchema: true
```

See the monorepo root README for full configuration surface.

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
