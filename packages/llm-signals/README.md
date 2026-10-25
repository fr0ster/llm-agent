# @mcp-abap-adt/llm-signals

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

An optional in-process signal bus with synchronous queued delivery, immutable payloads,
source filters and latest retention per `(name, source, key)`. Contracts and the
versioned dialogue catalog live in `@mcp-abap-adt/llm-agent`.

```ts
import type { DialogueSignals } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '@mcp-abap-adt/llm-agent-libs';
import { createSignalBus } from '@mcp-abap-adt/llm-signals';

const signals = createSignalBus<DialogueSignals>({
  onHandlerError: (error) => console.error(error),
});
signals.on('dialogue.turn.settled', signal => console.log(signal.payload));
// Supply your existing planner and task board options.
const session = await DialogueSession.open({ id: 'chat', planner, board, signals });
```

Replace the whole implementation with any `ISignalEmitter` or `ISignalBus`.
Replace a part with `combineEmitters(bus, metricsEmitter)` or
`filterEmitter(bus, (name, source) => source === 'chat')`. `noopEmitter()` disables
emission. Producers clone snapshots; the default bus deep-freezes them and isolates
handler failures. Payloads must be plain data: plain objects, arrays, and
string/number/boolean/null/undefined values. The default bus recursively validates
payloads before retention and dispatch. It drops invalid signals (including Map,
Set, typed arrays/ArrayBuffer views, Date, and class instances) and reports a
TypeError naming the signal and payload path through `onHandlerError`; `emit`
never throws. Nested emissions only enqueue; the outermost call drains the queue.
Retirement drops retained state at its queue position, allowing the same source id
to start afresh. `last` and `lastAll` expose retained state without replaying handlers.

Signals are one-way facts. Queries use retention or `session.snapshot()`; commands
use the producer's methods and tools. In-process bridges own external protocols
(SSE, MCP notifications, webhooks), reconnect ordering, acknowledgements and retries.
