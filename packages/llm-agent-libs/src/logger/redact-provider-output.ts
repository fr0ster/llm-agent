import type { CallOptions } from '@mcp-abap-adt/llm-agent';

type LogValue =
  | object
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;
type SessionStepLogger = NonNullable<CallOptions['sessionLogger']>;

function snapshot(value: LogValue, copies: WeakMap<object, object>): LogValue {
  if (typeof value === 'function') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  const cached = copies.get(value);
  if (cached) return cached;

  const source = value as Record<string, LogValue>;
  const copy: object = Array.isArray(value)
    ? new Array(value.length)
    : value instanceof Date
      ? new Date(value.getTime())
      : {};
  copies.set(value, copy);
  for (const key of Object.keys(source)) {
    // Raw Responses output can carry the same encrypted reasoning.
    if (
      key === 'providerOutput' ||
      (key === 'encrypted_content' && source.type === 'reasoning')
    ) {
      continue;
    }
    Object.defineProperty(copy, key, {
      value: snapshot(source[key], copies),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/** Take a log-only snapshot so redaction cannot change the live transcript. */
export function redactProviderOutput<T>(data: T): LogValue {
  return snapshot(data as LogValue, new WeakMap());
}

const redactingLoggers = new WeakMap<SessionStepLogger, SessionStepLogger>();

export function redactingSessionLogger(
  logger: CallOptions['sessionLogger'],
): CallOptions['sessionLogger'] {
  if (!logger) return;
  const cached = redactingLoggers.get(logger);
  if (cached) return cached;
  const wrapped: SessionStepLogger = {
    logStep<T>(name: string, data: T, area?: string) {
      logger.logStep(name, redactProviderOutput(data), area);
    },
  };
  redactingLoggers.set(logger, wrapped);
  redactingLoggers.set(wrapped, wrapped);
  return wrapped;
}
