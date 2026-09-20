import type { ITextLogger } from './text-logger.js';
import type { ILogger, LogEvent } from './types.js';

/** Either logger a consumer may hand to an input seam. */
export type AnyLogger = ILogger | ITextLogger;

/**
 * An event logger has a callable `log`; a text logger does not.
 *
 * **Precedence is deliberate, and it is part of the contract.** Structural
 * typing lets one object satisfy BOTH shapes — a text logger that also exposes
 * `log`. Such an object is treated as an EVENT logger and returned unchanged.
 * That keeps every logger that works today working exactly as it does today,
 * which is this release's binding constraint; deciding the other way would
 * silently re-route an existing consumer's events through the level mapping.
 * A consumer who wants the text path for a hybrid object passes only its text
 * methods, or wraps it.
 */
export function isTextLogger(logger: AnyLogger): logger is ITextLogger {
  return typeof (logger as ILogger).log !== 'function';
}

/** Levels per §7: only these three sets differ from `info`. */
const ERROR_EVENTS = new Set<LogEvent['type']>(['pipeline_error']);
const WARN_EVENTS = new Set<LogEvent['type']>(['warning']);
const DEBUG_EVENTS = new Set<LogEvent['type']>([
  'rag_upsert',
  'rag_query',
  'tools_selected',
]);

/**
 * Normalise whatever a consumer passed into the event logger the internals
 * already speak. An `ILogger` is returned unchanged — the existing path does
 * not move — and an `ITextLogger` is wrapped.
 *
 * The event's `type` is the message (a `warning` carries its own), and the
 * whole event travels as `meta`: a structured event fits inside `meta`, while
 * a closed union could never carry arbitrary text.
 */
export function normaliseLogger(logger: AnyLogger): ILogger {
  if (!isTextLogger(logger)) return logger;

  return {
    log(event: LogEvent): void {
      const message = event.type === 'warning' ? event.message : event.type;
      if (ERROR_EVENTS.has(event.type)) logger.error(message, event);
      else if (WARN_EVENTS.has(event.type)) logger.warn(message, event);
      else if (DEBUG_EVENTS.has(event.type)) logger.debug(message, event);
      else logger.info(message, event);
    },
  };
}
