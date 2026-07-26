import type { ServerResponse } from 'node:http';
import { normalizeHeartbeatMs } from '@mcp-abap-adt/llm-agent-libs';

export interface IdleHeartbeat {
  /** Re-arm the idle timer. Call on every real chunk written to the client. */
  reset(): void;
  /** Cancel the timer permanently. Idempotent. */
  stop(): void;
}

export interface IdleHeartbeatOptions {
  /** Raw configured interval (may be undefined). Normalized internally. */
  intervalMs: number | undefined;
  /** Invoked once each time the stream stays idle for the normalized interval. */
  onBeat: () => void;
  /** Timer injection for deterministic tests. Default: global setTimeout/clearTimeout. */
  schedule?: (cb: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

const NOOP: IdleHeartbeat = {
  reset() {},
  stop() {},
};

export function createIdleHeartbeat(opts: IdleHeartbeatOptions): IdleHeartbeat {
  const ms = normalizeHeartbeatMs(opts.intervalMs);
  if (ms === null) return NOOP;

  const schedule =
    opts.schedule ?? ((cb: () => void, d: number) => setTimeout(cb, d));
  const cancel =
    opts.cancel ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let handle: unknown;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return; // never schedule after stop
    handle = schedule(() => {
      if (stopped) return; // a stop() between scheduling and firing
      opts.onBeat();
      if (stopped) return; // onBeat() may have stopped us synchronously (e.g. res close)
      arm();
    }, ms);
  };
  const clear = (): void => {
    if (handle !== undefined) {
      cancel(handle);
      handle = undefined;
    }
  };

  arm();

  return {
    reset() {
      if (stopped) return;
      clear();
      arm();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clear();
    },
  };
}

/**
 * Wire an idle keep-alive to an SSE response: `onBeat` writes a keep-alive
 * comment and `res 'close'` stops the timer. `intervalMs` is the RAW configured
 * value (may be undefined) — normalization happens inside `createIdleHeartbeat`.
 */
export function attachSseKeepAlive(
  res: ServerResponse,
  intervalMs: number | undefined,
): IdleHeartbeat {
  const hb = createIdleHeartbeat({
    intervalMs,
    onBeat: () => res.write(': keep-alive\n\n'),
  });
  res.on('close', () => hb.stop());
  return hb;
}
