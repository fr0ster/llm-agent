import type {
  CallOptions,
  JsonValue,
  RagCaller,
} from '@mcp-abap-adt/llm-agent';

export type CallerIdentity = Pick<RagCaller, 'userId' | 'sessionId'>;

/** Clear exact caller pairs and legacy session keys without key-prefix matches. */
export function clearCallerSessionEntries<T>(
  entries: Map<string, T>,
  sessionId: string,
): void {
  for (const key of entries.keys()) {
    let matches = key === sessionId;
    try {
      const pair: JsonValue = JSON.parse(key);
      if (
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string'
      )
        matches = pair[1] === sessionId;
    } catch {
      // An unencoded legacy key can only match the session ID itself.
    }
    if (matches) entries.delete(key);
  }
}

export type CallerResolution =
  | { readonly kind: 'caller'; readonly caller: RagCaller }
  | { readonly kind: 'denied' }
  | { readonly kind: 'anonymous' };

// Internal carrier across IPipeline's CallOptions boundary. Object spreads
// preserve the decision, including a denial, without exposing a public option.
const callerResolution = Symbol('callerResolution');
type ResolvedOptions = CallOptions & {
  readonly [callerResolution]: CallerResolution;
};

export function callerResolutionKey(
  identity: CallerResolution,
): string | undefined {
  return identity.kind === 'caller'
    ? callerIdentityKey(identity.caller)
    : undefined;
}

/** Read an entry decision without ever falling back to raw request IDs. */
export function readCallerResolution(
  options: CallOptions | undefined,
): CallerResolution {
  return (
    (options as Partial<ResolvedOptions> | undefined)?.[callerResolution] ?? {
      kind: 'anonymous',
    }
  );
}

/** Resolve once at a request entry; an inherited decision is final. */
export function withResolvedCaller(
  options: CallOptions | undefined,
  sessionId = options?.sessionId ?? options?.caller?.sessionId,
): ResolvedOptions {
  const inherited = (options as Partial<ResolvedOptions> | undefined)?.[
    callerResolution
  ];
  const resolution = inherited ?? resolveCallerIdentity(options, sessionId);
  return {
    ...options,
    sessionId,
    caller: resolution.kind === 'caller' ? resolution.caller : undefined,
    [callerResolution]: resolution,
  };
}

/** Match RAG identity validation; keep the original, case-sensitive IDs. */
export function callerIdentityKey(
  caller: CallerIdentity | undefined,
): string | undefined {
  if (
    typeof caller?.userId !== 'string' ||
    !caller.userId.trim() ||
    typeof caller.sessionId !== 'string' ||
    !caller.sessionId.trim()
  )
    return undefined;
  return JSON.stringify([caller.userId, caller.sessionId]);
}

/** An explicit caller is authoritative; inconsistent request IDs fail closed. */
export function resolveCallerIdentity(
  options: CallOptions | undefined,
  sessionId = options?.sessionId ?? options?.caller?.sessionId,
): CallerResolution {
  const inherited = (options as Partial<ResolvedOptions> | undefined)?.[
    callerResolution
  ];
  if (inherited) return inherited;
  if (options?.caller === undefined && options?.userId === undefined)
    return { kind: 'anonymous' };
  const caller = options?.caller ?? {
    userId: options?.userId ?? '',
    sessionId: sessionId ?? '',
    isAdmin: false,
  };
  if (
    !callerIdentityKey(caller) ||
    caller.sessionId !== sessionId ||
    (options?.sessionId !== undefined &&
      options.sessionId !== caller.sessionId) ||
    (options?.userId !== undefined && options.userId !== caller.userId)
  )
    return { kind: 'denied' };
  return { kind: 'caller', caller };
}

/** Compatibility helper for callers that only need the validated caller. */
export function resolveCaller(
  options: CallOptions | undefined,
  sessionId = options?.sessionId ?? options?.caller?.sessionId,
): RagCaller | undefined {
  const resolution = resolveCallerIdentity(options, sessionId);
  return resolution.kind === 'caller' ? resolution.caller : undefined;
}
