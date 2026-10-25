# @mcp-abap-adt/llm-signals

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
handler failures. Nested emissions only enqueue; the outermost call drains the queue.
Retirement drops retained state at its queue position, allowing the same source id
to start afresh. `last` and `lastAll` expose retained state without replaying handlers.

Signals are one-way facts. Queries use retention or `session.snapshot()`; commands
use the producer's methods and tools. In-process bridges own external protocols
(SSE, MCP notifications, webhooks), reconnect ordering, acknowledgements and retries.
