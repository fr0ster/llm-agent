import type { ToolTrace, ToolTraceEntry } from './interfaces/tool-trace.js';
import {
  TOOL_TRACE_ARGUMENT_CHARS,
  TOOL_TRACE_ERROR_CHARS,
  TOOL_TRACE_MAX_ENTRIES,
  TOOL_TRACE_RESULT_CHARS,
} from './interfaces/tool-trace.js';

export type TraceJson =
  | null
  | boolean
  | number
  | string
  | TraceJson[]
  | { [key: string]: TraceJson };
function collectSecrets(
  value: TraceJson,
  secrets: string[],
  protectedValue = true,
): void {
  if (typeof value === 'string') {
    const remember = (secret: string): void => {
      if (secret.length >= 4 && secret !== '[redacted]') secrets.push(secret);
    };
    scrub(value, remember);
    if (protectedValue) {
      remember(value);
      const authorization = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
      if (authorization) remember(authorization[1]);
    }
    if (/^[\s]*[[{]/.test(value)) {
      try {
        const nested: TraceJson = JSON.parse(value);
        collectSecrets(nested, secrets, protectedValue);
      } catch {
        /* Plain text and incomplete JSON are scrubbed by the sanitizer. */
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value))
      collectSecrets(
        child,
        secrets,
        protectedValue ||
          sensitive.test(key.replace(/[_\s-]/g, '')) ||
          /headers?/i.test(key),
      );
  }
}

const sensitive = /password|secret|token|authorization|apikey|credential/i;
const cut = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 14)}...[truncated]`;

const credentialAssignment =
  /((?:password|secret|token|authorization|api[_\s-]?key|credential)["']?\s*[=:]\s*)(?!"\[redacted\]"|'\[redacted\]'|\[redacted\])("(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s,;}]+)/gi;
const authorizationValue = /\b(Bearer|Basic)\s+([^\s"',}]+)/gi;
const headerLine = /^.*(?:authorization|headers?)\s*:([^\r\n]*)$/gim;
const otherHeaderLine =
  /^(?:[\w]+-[\w-]+|cookie|host|accept)\s*:([^\r\n]*)$/gim;

function scrub(text: string, remember?: (secret: string) => void): string {
  if (remember) {
    for (const match of text.matchAll(credentialAssignment)) {
      const value = match[2];
      const quote = value[0];
      if (quote === '"') {
        try {
          const decoded: TraceJson = JSON.parse(value);
          if (typeof decoded === 'string') {
            remember(decoded);
            continue;
          }
        } catch {
          /* Incomplete literals still use the assignment fallback. */
        }
      }
      remember(
        quote === '"' || quote === "'"
          ? value.slice(1, value.endsWith(quote) ? -1 : undefined)
          : value,
      );
    }
    for (const match of text.matchAll(authorizationValue)) remember(match[2]);
    for (const pattern of [headerLine, otherHeaderLine]) {
      for (const match of text.matchAll(pattern)) remember(match[1].trim());
    }
  }
  return text
    .replace(headerLine, '[redacted]')
    .replace(otherHeaderLine, '[redacted]')
    .replace(credentialAssignment, '$1[redacted]')
    .replace(authorizationValue, '$1 [redacted]');
}

export function sanitizeTraceValue(
  value: object | string | number | boolean | null | undefined,
  limit: number,
  knownSecrets: readonly string[] = [],
): string {
  const secrets: string[] = [...knownSecrets];
  function visit(item: TraceJson): TraceJson {
    if (typeof item === 'string') {
      if (/^[\s]*[[{]/.test(item)) {
        try {
          const nested: TraceJson = JSON.parse(item);
          collectSecrets(nested, secrets, false);
          return JSON.stringify(visit(nested));
        } catch {
          /* Bounded excerpts and plain text still require scrubbing. */
        }
      }
      let text = scrub(item);
      for (const secret of secrets.sort((a, b) => b.length - a.length))
        text = text.split(secret).join('[redacted]');
      return text;
    }
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(visit);
    const result: { [key: string]: TraceJson } = {};
    for (const [key, child] of Object.entries(item)) {
      if (/headers?/i.test(key)) {
        collectSecrets(child, secrets);
        continue;
      }
      if (sensitive.test(key.replace(/[_\s-]/g, ''))) {
        collectSecrets(child, secrets);
        result[key] = '[redacted]';
      } else result[key] = visit(child);
    }
    return result;
  }
  try {
    let input: TraceJson;
    if (typeof value === 'string') {
      if (/^[\s]*[[{]/.test(value) && !value.endsWith('...[truncated]')) {
        try {
          input = JSON.parse(value);
        } catch {
          input = value;
        }
      } else input = value;
    } else {
      input = JSON.parse(
        JSON.stringify(
          value instanceof Error ? { message: value.message } : value,
        ),
      );
    }
    collectSecrets(input, secrets, false);
    const clean = visit(input);
    let text = typeof clean === 'string' ? clean : JSON.stringify(clean);
    for (const secret of secrets.sort((a, b) => b.length - a.length))
      text = text.split(secret).join('[redacted]');
    return cut(text, limit);
  } catch {
    return '[redacted]';
  }
}

export function normalizeToolTraceEntry(entry: ToolTraceEntry): ToolTraceEntry {
  const secrets: string[] = [];
  for (const text of [
    entry.arguments,
    entry.resultExcerpt,
    entry.error ?? '',
  ]) {
    collectSecrets(text, secrets, false);
  }
  const base = {
    sequence: entry.sequence,
    toolName: sanitizeTraceValue(entry.toolName, 200, secrets),
    arguments: sanitizeTraceValue(
      entry.arguments,
      TOOL_TRACE_ARGUMENT_CHARS,
      secrets,
    ),
    resultExcerpt:
      entry.outcome === 'unsettled'
        ? ''
        : sanitizeTraceValue(
            entry.resultExcerpt,
            TOOL_TRACE_RESULT_CHARS,
            secrets,
          ),
  };
  return entry.outcome === 'error'
    ? {
        ...base,
        outcome: 'error',
        error: sanitizeTraceValue(entry.error, TOOL_TRACE_ERROR_CHARS, secrets),
      }
    : { ...base, outcome: entry.outcome };
}

export class ToolTraceCollector {
  private readonly entries = new Map<number, ToolTraceEntry>();
  private omittedCount = 0;
  private closed = false;
  private finalComplete?: boolean;
  private pending = 0;
  private dispatchedThrough = 0;
  observe(entry: ToolTraceEntry): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) return;
    const previous = this.entries.get(entry.sequence);
    if (
      entry.outcome === 'unsettled' &&
      entry.sequence > this.dispatchedThrough
    ) {
      this.pending++;
      this.dispatchedThrough = entry.sequence;
    } else if (
      entry.outcome !== 'unsettled' &&
      entry.sequence <= this.dispatchedThrough &&
      (!previous || previous.outcome === 'unsettled')
    ) {
      this.pending = Math.max(0, this.pending - 1);
    }
    const retained = [...this.entries.keys()].sort((a, b) => a - b);
    if (
      retained.length === TOOL_TRACE_MAX_ENTRIES &&
      !this.entries.has(entry.sequence) &&
      entry.sequence > retained[24] &&
      entry.sequence < retained[25]
    )
      return;
    this.entries.set(entry.sequence, normalizeToolTraceEntry(entry));
    if (this.entries.size > TOOL_TRACE_MAX_ENTRIES) {
      const keys = [...this.entries.keys()].sort((a, b) => a - b);
      this.entries.delete(keys[25]);
      this.omittedCount++;
    }
  }
  snapshot(complete = true): ToolTrace {
    const entries = [...this.entries.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => ({ ...entry }));
    return {
      entries,
      omittedCount: this.omittedCount,
      complete:
        complete &&
        (this.finalComplete ?? true) &&
        this.pending === 0 &&
        entries.every((entry) => entry.outcome !== 'unsettled'),
    };
  }
  finalize(complete = true): ToolTrace {
    this.finalComplete ??= complete;
    this.closed = true;
    return this.snapshot(complete);
  }
}

export function normalizeToolTrace(trace: ToolTrace): ToolTrace {
  const collector = new ToolTraceCollector();
  for (const entry of trace.entries) collector.observe(entry);
  const result = collector.finalize(trace.complete);
  result.omittedCount += Math.max(0, Math.floor(trace.omittedCount) || 0);
  return result;
}

const sequences = new WeakMap<(entry: ToolTraceEntry) => void, number>();
export async function recordToolInvocation<T extends { ok: boolean }>(
  observer: ((entry: ToolTraceEntry) => void) | undefined,
  toolName: string,
  args: Record<string, unknown>,
  invoke: () => Promise<T>,
  describe: (result: T) => {
    failed: boolean;
    value: object | string;
    error: string;
  },
): Promise<T> {
  if (!observer) return invoke();
  const sequence = (sequences.get(observer) ?? 0) + 1;
  sequences.set(observer, sequence);
  const secrets: string[] = [];
  try {
    const json: TraceJson = JSON.parse(JSON.stringify(args));
    collectSecrets(json, secrets, false);
  } catch {
    /* Serialization failures use redacted fallbacks. */
  }
  const base = {
    sequence,
    toolName,
    arguments: sanitizeTraceValue(args, TOOL_TRACE_ARGUMENT_CHARS, secrets),
    resultExcerpt: '',
  };
  const notify = (entry: ToolTraceEntry): void => {
    try {
      observer(
        normalizeToolTraceEntry({
          ...entry,
          toolName: sanitizeTraceValue(entry.toolName, 200, secrets),
          arguments: sanitizeTraceValue(
            args,
            TOOL_TRACE_ARGUMENT_CHARS,
            secrets,
          ),
        }),
      );
    } catch {
      /* Observers cannot affect execution. */
    }
  };
  notify({ ...base, outcome: 'unsettled' });
  try {
    const result = await invoke();
    const description = describe(result);
    try {
      const evidence: TraceJson = JSON.parse(JSON.stringify(description.value));
      collectSecrets(evidence, secrets, false);
    } catch {
      /* Serialization failures use redacted fallbacks. */
    }
    collectSecrets(description.error, secrets, false);
    const resultExcerpt = sanitizeTraceValue(
      description.value,
      TOOL_TRACE_RESULT_CHARS,
      secrets,
    );
    notify(
      description.failed
        ? {
            ...base,
            outcome: 'error',
            resultExcerpt,
            error: sanitizeTraceValue(
              description.error,
              TOOL_TRACE_ERROR_CHARS,
              secrets,
            ),
          }
        : { ...base, outcome: 'ok', resultExcerpt },
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '[redacted]';
    collectSecrets(message, secrets, false);
    notify({
      ...base,
      outcome: 'error',
      error: sanitizeTraceValue(message, TOOL_TRACE_ERROR_CHARS, secrets),
    });
    throw error;
  }
}

const externalEvidenceGaps = new WeakSet<(entry: ToolTraceEntry) => void>();
export function markExternalTraceUnavailable(
  observer?: (entry: ToolTraceEntry) => void,
): void {
  if (observer) externalEvidenceGaps.add(observer);
}
export function hasExternalTraceGap(
  observer: (entry: ToolTraceEntry) => void,
): boolean {
  return externalEvidenceGaps.has(observer);
}
