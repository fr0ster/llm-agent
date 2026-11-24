import { randomUUID } from 'node:crypto';
import {
  type Message,
  overflowError,
  toAbortError,
} from '@mcp-abap-adt/llm-agent';
import {
  type CallerIdentity,
  callerIdentityKey,
  clearCallerSessionEntries,
} from './caller-identity.js';

export interface PendingToolResult {
  toolCallId: string;
  toolName: string;
  text: string;
}

export interface PendingSourceMessages {
  input: Message[];
  /** Completed rounds within this request that the client never received. */
  continuation: Message[];
}

export interface PendingToolCallsEntry {
  exchangeId: string;
  assistantMessage: Message;
  precedingMessages?: Message[];
  /** Logical history before assembly, without generated system or RAG text. */
  sourceMessages?: PendingSourceMessages;
  /** Client and history use the same globally unique recorded call IDs. */
  externalCalls: Array<{ toolCallId: string; returnedId: string }>;
  promise: Promise<PendingToolResult[]>;
  createdAt: number;
}

type PendingToolCallsInput = Omit<
  PendingToolCallsEntry,
  'exchangeId' | 'externalCalls'
> & { externalCalls?: Array<{ toolCallId: string }> };

/** Build the response exchange even when no caller may persist it. */
export function createPendingToolCallsEntry(
  entry: PendingToolCallsInput,
): PendingToolCallsEntry {
  return {
    ...entry,
    exchangeId: randomUUID(),
    externalCalls: (entry.externalCalls ?? []).map((call) => ({
      toolCallId: call.toolCallId,
      returnedId: call.toolCallId,
    })),
  };
}

interface CompletedToolExchange {
  externalCalls: PendingToolCallsEntry['externalCalls'];
  assistantMessage: Message;
  toolMessages: Message[];
  continuation: Message[];
}

/** Each suspension owns fresh IDs, independent of tool names and arguments. */
export function createExternalSuspension(calls: readonly { id: string }[]): {
  exchangeId: string;
  externalCalls: PendingToolCallsEntry['externalCalls'];
} {
  const exchangeId = randomUUID();
  return {
    exchangeId,
    externalCalls: calls.map((call, index) => ({
      toolCallId: call.id,
      returnedId: `ext:${exchangeId}:${index}`,
    })),
  };
}

export class PendingToolResultsRegistry {
  private readonly sessions = new Map<string, PendingToolCallsEntry>();
  // Completed exchanges live until clear() or registry disposal, without limits.
  private readonly completed = new Map<
    string,
    Map<string, CompletedToolExchange>
  >();

  clear(caller: CallerIdentity | undefined): void {
    const key = callerIdentityKey(caller);
    if (key === undefined) return;
    this.sessions.delete(key);
    this.completed.delete(key);
  }

  clearSession(sessionId: string): void {
    clearCallerSessionEntries(this.sessions, sessionId);
    clearCallerSessionEntries(this.completed, sessionId);
  }

  constructor(private readonly ttlMs = 5 * 60 * 1000) {}

  set(
    caller: CallerIdentity | undefined,
    entry: PendingToolCallsInput,
  ): PendingToolCallsEntry {
    const pending = createPendingToolCallsEntry(entry);
    const key = callerIdentityKey(caller);
    if (key === undefined) return pending;
    this.sessions.set(key, pending);
    if (this.sessions.size > 100) this.pruneAll();
    return pending;
  }

  has(caller: CallerIdentity | undefined, now = Date.now()): boolean {
    const key = callerIdentityKey(caller);
    if (key === undefined) return false;
    const entry = this.sessions.get(key);
    if (!entry) return false;
    if (now - entry.createdAt > this.ttlMs) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  /** Normalize both resume forms before retrieval and context assembly. */
  async prepareInput(
    caller: CallerIdentity | undefined,
    input: string | Message[],
    externalResults?: ReadonlyMap<string, string>,
  ): Promise<string | Message[]> {
    const key = callerIdentityKey(caller);
    if (key === undefined) return input;
    if (Array.isArray(input)) {
      input = this.restoreCompletedInput(caller, input);
    }
    if (!this.has(caller)) return input;
    const entry = this.sessions.get(key);
    if (!entry || entry.externalCalls.length === 0) return input;
    const messages: Message[] =
      typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    const index = findPendingAssistant(messages, entry.externalCalls);
    const localResults = await entry.promise.catch((error) => {
      const terminal = toAbortError(error) ?? overflowError(error);
      if (!terminal) return [];
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
      throw terminal;
    });
    const assistant = entry.assistantMessage;
    const results = (assistant.tool_calls ?? []).map((call): Message => {
      const external = entry.externalCalls.find(
        (candidate) => candidate.returnedId === call.id,
      );
      const supplied = messages.find(
        (message, position) =>
          position > index &&
          message.role === 'tool' &&
          message.tool_call_id === call.id,
      );
      return {
        role: 'tool',
        tool_call_id: call.id,
        content: external
          ? (supplied?.content ??
            externalResults?.get(call.id) ??
            'Error: external tool result was not provided.')
          : (localResults.find((result) => result.toolCallId === call.id)
              ?.text ?? 'Error: tool result was not provided.'),
      };
    });
    const ids = new Set(results.map((result) => result.tool_call_id));
    let end = index + 1;
    while (messages[end]?.role === 'tool') end++;
    const tail = [
      ...messages
        .slice(index + 1, end)
        .filter((message) => !ids.has(message.tool_call_id)),
      ...messages.slice(end),
    ];
    const continuation = entry.sourceMessages?.continuation ?? [];
    // Some hosts send model history, including completed internal rounds.
    // Recorded call IDs identify the exact contiguous continuation before this
    // suspension, independently of repeated model IDs. Text is never compared.
    const includesContinuation = hasContinuation(messages, index, continuation);
    return [
      ...(index >= 0
        ? messages.slice(0, index)
        : this.restoreCompletedInput(
            caller,
            entry.sourceMessages?.input ?? entry.precedingMessages ?? [],
          )),
      ...(includesContinuation ? [] : continuation),
      assistant,
      ...results,
      ...(index >= 0 ? tail : messages),
    ];
  }

  /** Retain the full model exchange under this session's client-visible IDs. */
  complete(
    caller: CallerIdentity | undefined,
    entry: Pick<
      PendingToolCallsEntry,
      'assistantMessage' | 'externalCalls' | 'sourceMessages'
    >,
    toolMessages: Message[],
  ): void {
    const key = callerIdentityKey(caller);
    if (key === undefined || entry.externalCalls.length === 0) return;
    let exchanges = this.completed.get(key);
    if (!exchanges) {
      exchanges = new Map();
      this.completed.set(key, exchanges);
    }
    const exchange: CompletedToolExchange = structuredClone({
      externalCalls: entry.externalCalls,
      assistantMessage: entry.assistantMessage,
      toolMessages,
      continuation: entry.sourceMessages?.continuation ?? [],
    });
    for (const call of entry.externalCalls) {
      exchanges.set(call.returnedId, exchange);
    }
  }

  private restoreCompletedInput(
    caller: CallerIdentity | undefined,
    messages: Message[],
  ): Message[] {
    const key = callerIdentityKey(caller);
    if (key === undefined) return messages;
    const exchanges = this.completed.get(key);
    if (!exchanges) return messages;
    const restored: Message[] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const exchange =
        message.role === 'assistant'
          ? message.tool_calls
              ?.map((call) => exchanges.get(call.id))
              .find((candidate) => candidate !== undefined)
          : undefined;
      if (
        !exchange?.externalCalls.every((external) =>
          message.tool_calls?.some((call) => call.id === external.returnedId),
        )
      ) {
        restored.push(message);
        continue;
      }
      const continuation = hasContinuation(
        messages,
        index,
        exchange.continuation,
      )
        ? []
        : exchange.continuation;
      restored.push(
        ...structuredClone([
          ...continuation,
          exchange.assistantMessage,
          ...exchange.toolMessages,
        ]),
      );
      const recordedIds = new Set(
        exchange.assistantMessage.tool_calls?.map((call) => call.id),
      );
      // Drop echoed results only within this exchange's tool block. The
      // restored results carry the very same IDs and must remain in history.
      while (messages[index + 1]?.role === 'tool') {
        const result = messages[++index];
        if (!recordedIds.has(result.tool_call_id ?? '')) {
          restored.push(result);
        }
      }
    }
    return restored;
  }

  async consume(
    caller: CallerIdentity | undefined,
    now = Date.now(),
  ): Promise<{
    exchangeId: string;
    assistantMessage: Message;
    precedingMessages?: Message[];
    sourceMessages?: PendingSourceMessages;
    externalCalls: PendingToolCallsEntry['externalCalls'];
    results: PendingToolResult[];
  } | null> {
    const key = callerIdentityKey(caller);
    if (key === undefined) return null;
    const entry = this.sessions.get(key);
    if (!entry) return null;
    if (now - entry.createdAt > this.ttlMs) {
      this.sessions.delete(key);
      return null;
    }
    this.sessions.delete(key);
    const results = await entry.promise.catch((error) => {
      const terminal = toAbortError(error) ?? overflowError(error);
      if (terminal) throw terminal;
      return [];
    });
    return {
      exchangeId: entry.exchangeId,
      assistantMessage: entry.assistantMessage,
      precedingMessages: entry.precedingMessages,
      sourceMessages: entry.sourceMessages,
      externalCalls: entry.externalCalls,
      results,
    };
  }

  get size(): number {
    return this.sessions.size;
  }

  private pruneAll(now = Date.now()): void {
    for (const [id, entry] of this.sessions.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }
}

function hasContinuation(
  messages: readonly Message[],
  index: number,
  continuation: readonly Message[],
): boolean {
  const start = index - continuation.length;
  return (
    start >= 0 &&
    continuation.some(
      (message) => message.role === 'assistant' && message.tool_calls?.length,
    ) &&
    continuation.every((message, offset) => {
      const candidate = messages[start + offset];
      if (message.role !== candidate.role) return false;
      if (message.role === 'tool')
        return message.tool_call_id === candidate.tool_call_id;
      if (message.tool_calls?.length)
        return (
          message.tool_calls.length === candidate.tool_calls?.length &&
          message.tool_calls.every(
            (call, callIndex) =>
              call.id === candidate.tool_calls?.[callIndex].id,
          )
        );
      return !candidate.tool_calls?.length;
    })
  );
}

export function findPendingAssistant(
  messages: readonly Message[],
  externalCalls: PendingToolCallsEntry['externalCalls'],
): number {
  return messages.findIndex(
    (message) =>
      message.role === 'assistant' &&
      externalCalls.length > 0 &&
      externalCalls.every((external) =>
        message.tool_calls?.some((call) => call.id === external.returnedId),
      ),
  );
}
