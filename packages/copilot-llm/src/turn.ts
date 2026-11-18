import { addAbortListener } from 'node:events';
import type { SessionEvent } from '@github/copilot-sdk';
import {
  LlmError,
  type LlmResponse,
  type LlmToolCall,
  type LlmUsage,
  type Message,
} from '@mcp-abap-adt/llm-agent';
import { aborted, CopilotThrottleError, sdkError } from './errors.js';
import type { CopilotSdkSession } from './sdk.js';

type EventData<T extends SessionEvent['type']> = Extract<
  SessionEvent,
  { type: T }
>['data'];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export async function withAbort<T>(
  action: Promise<T>,
  signal: AbortSignal,
  error = aborted,
): Promise<T> {
  if (signal.aborted) {
    void action.catch(() => {});
    throw error();
  }
  const cancellation = deferred<T>();
  const listener = addAbortListener(signal, () => cancellation.reject(error()));
  try {
    return await Promise.race([action, cancellation.promise]);
  } finally {
    listener[Symbol.dispose]();
  }
}

interface PendingTool {
  requestId: string;
  call: LlmToolCall;
}

function pendingTool(data: EventData<'external_tool.requested'>): PendingTool {
  const args = data.arguments;
  const object = args && typeof args === 'object' && !Array.isArray(args);
  return {
    requestId: data.requestId,
    call: {
      id: data.toolCallId,
      name: data.toolName,
      arguments: object ? args : {},
      ...(!object && args !== undefined
        ? {
            rawArguments:
              typeof args === 'string' ? args : JSON.stringify(args),
          }
        : {}),
    },
  };
}

function addUsage(
  usage: LlmUsage | undefined,
  data: EventData<'assistant.usage'>,
): LlmUsage | undefined {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = data;
  if (
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(
      (n) => n === undefined,
    )
  ) {
    return usage;
  }
  const promptTokens = (usage?.promptTokens ?? 0) + (inputTokens ?? 0);
  const completionTokens = (usage?.completionTokens ?? 0) + (outputTokens ?? 0);
  return {
    ...usage,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cacheReadTokens !== undefined
      ? { cachedInputTokens: (usage?.cachedInputTokens ?? 0) + cacheReadTokens }
      : {}),
    ...(cacheWriteTokens !== undefined
      ? {
          cacheCreationInputTokens:
            (usage?.cacheCreationInputTokens ?? 0) + cacheWriteTokens,
        }
      : {}),
  };
}

export class SessionTurn {
  private readonly pending = new Map<string, PendingTool>();
  private step?: (event: SessionEvent) => void;
  private suspended?: ReturnType<typeof addAbortListener>;
  firstUserEvent?: string;

  constructor(private readonly session: CopilotSdkSession) {}

  onEvent(event: SessionEvent): void {
    if (event.agentId) return;
    if (event.type === 'user.message') this.firstUserEvent ??= event.id;
    if (event.type === 'external_tool.requested') {
      this.pending.set(event.data.toolCallId, pendingTool(event.data));
    }
    if (event.type === 'external_tool.completed') {
      for (const [id, pending] of this.pending) {
        if (pending.requestId === event.data.requestId) this.pending.delete(id);
      }
    }
    this.step?.(event);
  }

  suspend(signal: AbortSignal, cancel: () => void): void {
    this.suspended = addAbortListener(signal, cancel);
  }

  resume(): void {
    this.suspended?.[Symbol.dispose]();
    this.suspended = undefined;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  clearPending(): void {
    this.resume();
    this.pending.clear();
  }

  matchingResults(messages: Message[]): Map<string, string> {
    const results = new Map<string, string>();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'tool') break;
      const id = message.tool_call_id;
      if (id && this.pending.has(id) && !results.has(id)) {
        results.set(id, message.content ?? '');
      }
    }
    return results;
  }

  async submitResults(
    results: Map<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const [id, result] of results) {
      if (signal.aborted) throw aborted();
      const tool = this.pending.get(id);
      if (!tool) continue;
      this.pending.delete(id);
      const reply = await this.session.rpc.tools.handlePendingToolCall({
        requestId: tool.requestId,
        result,
      });
      if (!reply.success)
        throw new LlmError(
          'Copilot did not accept the tool result',
          'COPILOT_ERROR',
        );
    }
  }

  async collect(
    start: () => Promise<void>,
    signal: AbortSignal,
    disconnected: AbortSignal,
    emit: (content: string) => void,
    continuation: boolean,
  ): Promise<LlmResponse> {
    const reply = deferred<LlmResponse>();
    let content: string | undefined;
    let deltas = '';
    let usage: LlmUsage | undefined;
    const expected = new Set<string>();
    let throttle: CopilotThrottleError | undefined;
    const finishTools = () => {
      if (
        !this.pending.size ||
        ![...expected].every((id) => this.pending.has(id))
      )
        return;
      reply.resolve({
        content: content ?? deltas,
        toolCalls: [...this.pending.values()].map(({ call }) => call),
        finishReason: 'tool_calls',
        usage,
      });
    };
    this.step = (event) => {
      switch (event.type) {
        case 'assistant.message_delta':
          deltas += event.data.deltaContent;
          emit(event.data.deltaContent);
          break;
        case 'assistant.message':
          // A response can arrive split into several messages; keep them all.
          content = (content ?? '') + event.data.content;
          for (const { toolCallId } of event.data.toolRequests ?? [])
            expected.add(toolCallId);
          break;
        case 'assistant.usage':
          usage = addUsage(usage, event.data);
          break;
        case 'external_tool.requested':
          queueMicrotask(finishTools);
          break;
        case 'session.error': {
          const error = sdkError(event.data);
          if (
            error instanceof CopilotThrottleError &&
            event.data.eligibleForAutoSwitch &&
            error.retryAfterSeconds === undefined
          ) {
            throttle = error;
          } else {
            reply.reject(error);
          }
          break;
        }
        case 'auto_mode_switch.requested':
          if (throttle)
            reply.reject(
              new CopilotThrottleError(event.data.retryAfterSeconds),
            );
          break;
        case 'session.idle':
          if (throttle) reply.reject(throttle);
          else if (event.data.aborted) reply.reject(aborted());
          else if (content !== undefined || deltas) {
            reply.resolve({
              content: content ?? deltas,
              finishReason: 'stop',
              usage,
            });
          } else {
            reply.reject(
              new LlmError(
                'Copilot became idle without a reply',
                'COPILOT_ERROR',
              ),
            );
          }
          break;
      }
    };
    try {
      const started = start().then(() => {
        if (continuation) finishTools();
      });
      const result = Promise.all([reply.promise, started]).then(
        ([response]) => response,
      );
      return await withAbort(
        result,
        AbortSignal.any([signal, disconnected]),
        () =>
          signal.aborted
            ? aborted()
            : new LlmError('Copilot session disconnected', 'COPILOT_ERROR'),
      );
    } finally {
      this.step = undefined;
    }
  }
}
