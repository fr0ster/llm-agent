# @mcp-abap-adt/typesafe-decision

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

TypeSafe AI (Jev) decision-model provider for `@mcp-abap-adt/llm-agent`.

Jev is not an LLM: it answers typed questions (`noul` yes/no, `choice`, `score`)
about a state with numbers only. This package implements `IDecisionModel` over
`@typesafe-ai/sdk`.

Exports:
- `TypeSafeDecisionModel` — implements `IDecisionModel`.
- `TypeSafeDecisionConfig` — configuration type.

```ts
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { TypeSafeDecisionModel } from '@mcp-abap-adt/typesafe-decision';

const model = new TypeSafeDecisionModel({
  credential: staticApiKey(process.env.DECISION_API_KEY ?? ''),
});
const r = await model.decide({
  state: 'I was charged twice.',
  questions: { billing: { type: 'noul', instructions: 'Is this about billing?' } },
});
if (r.ok) console.log(r.value.answers.billing);
```

The key is asked from the credential on every call, so a rotating key rotates.
`TYPESAFE_*` environment variables are never read: every client option is
passed explicitly. Data sent: the state and the questions go to TypeSafe's API.

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
