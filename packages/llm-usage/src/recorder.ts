import { randomUUID } from 'node:crypto';
import {
  type IUsageControl,
  type IUsageRecorder,
  type IUsageTransport,
  type UsageContext,
  UsageDeliveryError,
  type UsageInput,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';

export interface UsageRecorderOptions {
  transport: IUsageTransport;
  queueLimit?: number;
  batchSize?: number;
  flushMs?: number;
  retryWindowMs?: number;
  lossWindowMs?: number;
  reservedLossCapacity?: number;
  maxLossCounters?: number;
  now?: () => number;
  idFactory?: () => string;
  instanceId?: string;
}
interface Entry {
  record: UsageRecord;
  since: number;
  ambiguous: boolean;
  attempts: number;
}
interface Loss {
  session: string;
  start: number;
  from: number;
  to: number;
  counts: Record<string, number>;
}

function assertPlain(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === null ||
    value === undefined ||
    ['string', 'number', 'boolean'].includes(typeof value)
  )
    return;
  if (typeof value !== 'object' || ancestors.has(value))
    throw new TypeError('Usage data must be plain and acyclic');
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw new TypeError('Usage data must be plain');
  ancestors.add(value);
  for (const item of Object.values(value)) assertPlain(item, ancestors);
  ancestors.delete(value);
}

export function createUsageRecorder(
  options: UsageRecorderOptions,
): IUsageRecorder & IUsageControl {
  const {
    transport,
    queueLimit = 10000,
    batchSize = 200,
    flushMs = 1000,
    retryWindowMs = 300000,
    lossWindowMs = 60000,
    reservedLossCapacity = 100,
    maxLossCounters = 1000,
    now = Date.now,
    idFactory = randomUUID,
    instanceId = randomUUID(),
  } = options;
  for (const [name, value] of Object.entries({
    queueLimit,
    batchSize,
    lossWindowMs,
    maxLossCounters,
  })) {
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError(`${name} must be positive`);
  }
  const capacity = queueLimit + Math.max(0, reservedLossCapacity);
  const queue: Entry[] = [];
  const losses = new Map<string, Loss>();
  const lost: Record<string, number> = {};
  let delivered = 0;
  let definiteLoss = 0;
  let unconfirmed = 0;
  let lastErrorCode: string | undefined;
  let accepting = true;
  let finished = false;
  let running: Promise<void> | undefined;
  let pending: Entry[] = [];
  let nextAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closedThrough = -Infinity;
  let closing:
    | Promise<{ delivered: number; lost: number; unconfirmed: number }>
    | undefined;

  function account(entry: Entry, reason: string) {
    lost[reason] = (lost[reason] ?? 0) + 1;
    if (entry.ambiguous) unconfirmed++;
    else definiteLoss++;
    const record = entry.record;
    if (record.kind === 'x.usage.lost') return;
    emitLosses();
    const start = Math.max(
      closedThrough,
      Math.floor(now() / lossWindowMs) * lossWindowMs,
    );
    const session = record.context.sessionId ?? '';
    const key = `${start}:${session}`;
    let loss = losses.get(key);
    if (!loss) {
      loss = { session, start, from: record.at, to: record.at, counts: {} };
      losses.set(key, loss);
    }
    loss.from = Math.min(loss.from, record.at);
    loss.to = Math.max(loss.to, record.at);
    const kind = entry.ambiguous ? 'unconfirmed' : record.kind;
    loss.counts[kind] = (loss.counts[kind] ?? 0) + 1;
    while (losses.size > maxLossCounters) {
      const oldestKey = losses.keys().next().value as string;
      const oldest = losses.get(oldestKey) as Loss;
      losses.delete(oldestKey);
      const globalKey = `${oldest.start}:`;
      const global = losses.get(globalKey);
      if (global) {
        global.from = Math.min(global.from, oldest.from);
        global.to = Math.max(global.to, oldest.to);
        for (const [k, count] of Object.entries(oldest.counts))
          global.counts[k] = (global.counts[k] ?? 0) + count;
      } else {
        // Put the merged counter last so the next eviction can merge into it.
        losses.set(globalKey, { ...oldest, session: '' });
      }
    }
  }

  function emitLosses(all = false) {
    if (all)
      closedThrough = Math.max(
        closedThrough,
        (Math.floor(now() / lossWindowMs) + 1) * lossWindowMs,
      );
    for (const [key, loss] of losses) {
      if (!all && loss.start + lossWindowMs > now()) continue;
      losses.delete(key);
      closedThrough = Math.max(closedThrough, loss.start + lossWindowMs);
      const record: UsageRecord = {
        schema: 1,
        id: `lost:${instanceId}:${loss.session}:${loss.start}`,
        at: now(),
        context: { sessionId: loss.session },
        kind: 'x.usage.lost',
        outcome: 'error',
        values: {
          ...loss.counts,
          affectedFrom: loss.from,
          affectedTo: loss.to,
        },
      };
      const entry = { record, since: now(), ambiguous: false, attempts: 0 };
      if (queue.length < capacity) queue.push(entry);
      else account(entry, 'overflow');
    }
  }

  function pump(): Promise<void> {
    if (running) return running;
    if (finished || !queue.length || Date.now() < nextAttempt)
      return Promise.resolve();
    running = Promise.resolve()
      .then(async () => {
        while (!finished && queue.length) {
          for (const entry of [...queue]) {
            if (entry.attempts && now() - entry.since >= retryWindowMs) {
              queue.splice(queue.indexOf(entry), 1);
              account(entry, 'retryWindow');
            }
          }
          if (!queue.length || Date.now() < nextAttempt) break;
          pending = queue.slice(0, batchSize);
          try {
            await transport.send(structuredClone(pending.map((e) => e.record)));
            if (finished) return;
            delivered += pending.length;
            queue.splice(0, pending.length);
            nextAttempt = 0;
          } catch (error) {
            if (finished) return;
            const ambiguous =
              !(error instanceof UsageDeliveryError) || error.possiblyDelivered;
            lastErrorCode =
              error instanceof UsageDeliveryError ? error.code : 'UNKNOWN';
            for (const entry of pending) {
              entry.ambiguous ||= ambiguous;
              entry.attempts++;
              if (now() - entry.since >= retryWindowMs) {
                queue.splice(queue.indexOf(entry), 1);
                account(entry, 'retryWindow');
              }
            }
            nextAttempt =
              Date.now() +
              Math.min(1000, 10 * 2 ** Math.min(pending[0]?.attempts ?? 0, 7));
            emitLosses(!accepting);
            break;
          } finally {
            pending = [];
          }
        }
      })
      .finally(() => {
        running = undefined;
        if (retryTimer) clearTimeout(retryTimer);
        if (!finished && queue.length && nextAttempt) {
          const expiry = Math.min(
            ...queue
              .filter((entry) => entry.attempts > 0)
              .map((entry) => entry.since + retryWindowMs),
          );
          retryTimer = setTimeout(
            () => {
              nextAttempt = Math.min(nextAttempt, Date.now());
              void pump();
            },
            Math.max(0, Math.min(nextAttempt - Date.now(), expiry - now())),
          );
          retryTimer.unref();
        }
      });
    return running;
  }

  const timer = setInterval(
    () => {
      emitLosses();
      void pump();
    },
    Math.max(1, flushMs),
  );
  timer.unref();
  function scoped(context: UsageContext): IUsageRecorder {
    return {
      record(input: UsageInput) {
        if (!accepting) return;
        try {
          emitLosses();
          assertPlain(input);
          const snapshot = structuredClone(input);
          const record = {
            ...snapshot,
            schema: 1 as const,
            id: snapshot.id ?? idFactory(),
            at: snapshot.at ?? now(),
            context: { ...context, ...snapshot.context },
          } as UsageRecord;
          const entry = { record, since: now(), ambiguous: false, attempts: 0 };
          if (queue.length >= queueLimit) account(entry, 'overflow');
          else queue.push(entry);
          if (queue.length >= batchSize) void pump();
        } catch {
          lost.invalid = (lost.invalid ?? 0) + 1;
          definiteLoss++;
        }
      },
      with(extra) {
        assertPlain(extra);
        return scoped({ ...context, ...structuredClone(extra) });
      },
    };
  }

  async function until<T>(
    promise: Promise<T>,
    deadline: number,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } catch {
      /* Lifecycle failures must not escape shutdown. */
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async function drain(deadline: number) {
    while (queue.length && Date.now() < deadline) {
      await until(pump(), deadline);
      emitLosses(!accepting);
      if (queue.length && Date.now() < deadline && nextAttempt > Date.now()) {
        await until(
          new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(10, nextAttempt - Date.now())),
          ),
          deadline,
        );
      }
    }
  }
  return Object.assign(scoped({}), {
    async flush(timeoutMs: number) {
      emitLosses();
      await drain(Date.now() + Math.max(0, timeoutMs));
    },
    close(timeoutMs: number) {
      if (closing) return closing;
      closing = (async () => {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        accepting = false;
        clearInterval(timer);
        emitLosses(true);
        await drain(deadline);
        // A pending send is ambiguous even if an earlier attempt was refused.
        for (const entry of pending) entry.ambiguous = true;
        finished = true;
        if (retryTimer) clearTimeout(retryTimer);
        for (const entry of queue.splice(0)) account(entry, 'closeTimeout');
        emitLosses(true);
        // Evidence generated at the deadline cannot itself be delivered.
        for (const entry of queue.splice(0)) account(entry, 'closeTimeout');
        await until(
          Promise.resolve().then(() => transport.close()),
          deadline,
        );
        return { delivered, lost: definiteLoss, unconfirmed };
      })();
      return closing;
    },
    stats() {
      return {
        buffered: queue.length,
        delivered,
        lost: { ...lost },
        unconfirmed:
          unconfirmed + queue.filter((entry) => entry.ambiguous).length,
        lastErrorCode,
      };
    },
  });
}
