import {
  type ISignalEmitter,
  type ISignalSubscriber,
  type IUsageSink,
  type IUsageTransport,
  type Unsubscribe,
  UsageDeliveryError,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';

export interface BatchOptions {
  batchSize?: number;
  flushMs?: number;
}

export function directTransport(
  sink: IUsageSink,
  options: BatchOptions = {},
): IUsageTransport {
  return {
    async send(batch) {
      if (options.flushMs && options.flushMs > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.flushMs),
        );
      const size = Math.max(1, options.batchSize ?? 200);
      let written = false;
      try {
        for (let i = 0; i < batch.length; i += size) {
          await sink.write(batch.slice(i, i + size));
          written = true;
        }
      } catch (error) {
        if (!written) throw error;
        throw new UsageDeliveryError('Partial direct write', true);
      }
    },
    async close() {
      await sink.close?.();
    },
  };
}

export function httpTransport(
  options: BatchOptions & {
    url: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
  },
): IUsageTransport {
  return {
    async send(batch) {
      if (options.flushMs && options.flushMs > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.flushMs),
        );
      let sent = false;
      const size = Math.max(1, options.batchSize ?? 200);
      try {
        for (let i = 0; i < batch.length; i += size) {
          const response = await (options.fetch ?? globalThis.fetch)(
            options.url,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...options.headers,
              },
              body: JSON.stringify({
                schema: 1,
                records: batch.slice(i, i + size),
              }),
            },
          );
          if (!response.ok)
            throw new UsageDeliveryError(
              'Collector rejected batch',
              true,
              String(response.status),
            );
          sent = true;
        }
      } catch (error) {
        if (error instanceof UsageDeliveryError) {
          if (!sent || error.possiblyDelivered) throw error;
          throw new UsageDeliveryError(error.message, true, error.code);
        }
        const cause = error instanceof Error ? (error.cause ?? error) : error;
        const code =
          cause && typeof cause === 'object' && 'code' in cause
            ? String(cause.code)
            : undefined;
        throw new UsageDeliveryError(
          'HTTP delivery failed',
          sent || code !== 'ECONNREFUSED',
          code,
        );
      }
    },
    async close() {},
  };
}

export type UsageSignals = { 'usage.batch': { records: UsageRecord[] } };

export function signalTransport(
  emitter: ISignalEmitter<UsageSignals>,
  source: string,
): IUsageTransport {
  return {
    async send(batch) {
      emitter.emit(
        'usage.batch',
        { records: structuredClone([...batch]) },
        source,
        '',
      );
    },
    async close() {
      emitter.retire(source);
    },
  };
}

export function signalSource(
  subscriber: ISignalSubscriber<UsageSignals>,
  source: string,
  sink: IUsageSink,
): Unsubscribe {
  return subscriber.on(
    'usage.batch',
    async (signal) => {
      await sink.write(signal.payload.records);
    },
    { source },
  );
}
