# @mcp-abap-adt/sap-aicore-auth

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

SAP AI Core service-key token exchange: `AICORE_SERVICE_KEY` holds OAuth client
credentials, not a token, so something has to exchange them, cache the result
and refresh it before expiry.

## Installation

```bash
npm install @mcp-abap-adt/sap-aicore-auth
```

## Usage

```typescript
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY!);
// credential: IBearerCredential — parsing and the token exchange happen lazily,
// on the first credential.token() call, so a deployment that never names this
// credential does not need the key to be present or valid.
```

Lower-level building blocks (`TokenProvider`, `parseServiceKey`) are also exported
for consumers that already hold parsed client credentials or a service key.
