import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  CallOptions,
  ILlm,
  LlmCallRecord,
  LlmComponent,
  LlmError,
  LlmResponse,
  LlmTool,
  LlmUsage,
  LlmUsageAttribution,
  Message,
  ModelUsageEntry,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  addCacheTokenUsage,
  errorUsage,
  withUsageAttribution,
} from '@mcp-abap-adt/llm-agent';

export { errorUsage, withUsageAttribution };

export function usageCallRecords(
  attribution: LlmUsageAttribution,
  component: LlmComponent,
  durationMs: number,
  callId?: string,
  countEmpty = false,
): readonly LlmCallRecord[] {
  if (attribution.usageCalls) return attribution.usageCalls;
  if (attribution.usageByModel) {
    return Object.entries(attribution.usageByModel).map(([model, usage]) => ({
      ...usage,
      callId: randomUUID(),
      component,
      model,
      durationMs: 0,
    }));
  }
  if (!attribution.usage && !countEmpty) return [];
  return [
    {
      ...(attribution.usage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
      callId: callId ?? randomUUID(),
      component,
      model: attribution.model ?? 'unknown',
      durationMs,
    },
  ];
}

export function mergeUsageCalls(
  calls: readonly LlmCallRecord[],
  other: readonly LlmCallRecord[],
): readonly LlmCallRecord[] {
  const merged = new Map<string, LlmCallRecord>();
  for (const call of [...calls, ...other]) {
    if (!merged.has(call.callId)) merged.set(call.callId, call);
  }
  return [...merged.values()];
}

function addCall(bucket: ModelUsageEntry, call: LlmCallRecord): void {
  Object.assign(bucket, addCacheTokenUsage(bucket, call));
  bucket.promptTokens += call.promptTokens;
  bucket.completionTokens += call.completionTokens;
  bucket.totalTokens += call.totalTokens;
  bucket.requests += call.requests ?? 1;
}

const emptyUsage: ModelUsageEntry = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  requests: 0,
};

function usageRemainder(usage: LlmUsage, covered: ModelUsageEntry): LlmUsage {
  return {
    promptTokens: Math.max(0, usage.promptTokens - covered.promptTokens),
    completionTokens: Math.max(
      0,
      usage.completionTokens - covered.completionTokens,
    ),
    totalTokens: Math.max(0, usage.totalTokens - covered.totalTokens),
    ...(usage.cachedInputTokens !== undefined && {
      cachedInputTokens: Math.max(
        0,
        usage.cachedInputTokens - (covered.cachedInputTokens ?? 0),
      ),
    }),
    ...(usage.cacheCreationInputTokens !== undefined && {
      cacheCreationInputTokens: Math.max(
        0,
        usage.cacheCreationInputTokens -
          (covered.cacheCreationInputTokens ?? 0),
      ),
    }),
  };
}

/** Preserve each identified call and import only the uncovered returned usage. */
export function completeUsageCalls(
  attribution: LlmUsageAttribution,
  component: LlmComponent,
  durationMs: number,
  observed: readonly LlmCallRecord[] = [],
): readonly LlmCallRecord[] {
  const calls = [...mergeUsageCalls(observed, attribution.usageCalls ?? [])];
  const byModel = attribution.usageByModel;
  const covered = new Map<string, ModelUsageEntry>();
  const flat = { ...emptyUsage };
  for (const call of calls) {
    if (byModel) {
      if (!Object.hasOwn(byModel, call.model)) continue;
      let bucket = covered.get(call.model);
      if (!bucket) {
        bucket = { ...emptyUsage };
        covered.set(call.model, bucket);
      }
      addCall(bucket, call);
    } else {
      addCall(flat, call);
    }
  }
  if (byModel) {
    for (const [model, usage] of Object.entries(byModel)) {
      const accounted = covered.get(model) ?? emptyUsage;
      const remaining = usageRemainder(usage, accounted);
      const requests = Math.max(0, usage.requests - accounted.requests);
      if (
        requests > 0 ||
        Object.values(remaining).some((tokens) => tokens > 0)
      ) {
        calls.push({
          ...remaining,
          requests,
          callId: randomUUID(),
          component,
          model,
          durationMs: 0,
        });
      }
    }
  } else if (attribution.usage) {
    const remaining = usageRemainder(attribution.usage, flat);
    if (
      calls.length === 0 ||
      Object.values(remaining).some((tokens) => tokens > 0)
    ) {
      calls.push(
        ...usageCallRecords(
          { usage: remaining, model: attribution.model },
          component,
          durationMs,
        ),
      );
    }
  }
  return calls;
}

export function withUsageCalls<T>(
  error: T,
  calls: readonly LlmCallRecord[],
): T {
  const { usageCalls } = errorUsage(error);
  if (calls.length === 0 || calls === usageCalls) return error;
  return withUsageAttribution(error, {
    usageCalls: usageCalls ? mergeUsageCalls(calls, usageCalls) : calls,
  });
}

interface ChatUsageScope {
  component: LlmComponent;
  calls: LlmCallRecord[];
}

const chatUsage = new AsyncLocalStorage<ChatUsageScope>();

/** Record the innermost retry attempts through any intervening LLM decorators. */
export async function recordChatAttempt(
  llm: ILlm,
  run: () => Promise<Result<LlmResponse, LlmError>>,
  countFailed = false,
): Promise<Result<LlmResponse, LlmError>> {
  const parent = chatUsage.getStore();
  if (!parent) return run();

  const scope: ChatUsageScope = { component: parent.component, calls: [] };
  const start = Date.now();
  const callId = randomUUID();
  let attribution: LlmUsageAttribution = {};
  let succeeded = false;
  try {
    const result = await chatUsage.run(scope, run);
    succeeded = result.ok;
    attribution = result.ok ? result.value : errorUsage(result.error);
    return result;
  } catch (error) {
    attribution = errorUsage(error);
    throw error;
  } finally {
    const calls =
      scope.calls.length > 0
        ? scope.calls
        : usageCallRecords(
            { ...attribution, model: attribution.model ?? llm.model },
            scope.component,
            Date.now() - start,
            callId,
            succeeded || countFailed,
          );
    for (const call of calls) parent.calls.push(call);
  }
}

async function chatResultWithUsage(
  llm: ILlm,
  component: LlmComponent,
  messages: Message[],
  tools?: LlmTool[],
  options?: CallOptions,
): Promise<Result<LlmResponse, LlmError>> {
  const scope: ChatUsageScope = { component, calls: [] };
  try {
    const result = await chatUsage.run(scope, () =>
      recordChatAttempt(llm, () => llm.chat(messages, tools, options)),
    );
    if (!result.ok)
      return { ok: false, error: withUsageCalls(result.error, scope.calls) };
    return {
      ok: true,
      value: { ...result.value, usageCalls: scope.calls },
    };
  } catch (error) {
    throw withUsageCalls(error, scope.calls);
  }
}

/** Capture chat attempts for a strategy that can also stream. */
export function llmWithChatUsage(llm: ILlm, component: LlmComponent): ILlm {
  return {
    get model() {
      return llm.model;
    },
    chat: (messages, tools, options) =>
      chatResultWithUsage(llm, component, messages, tools, options),
    streamChat: (messages, tools, options) =>
      llm.streamChat(messages, tools, options),
    healthCheck: llm.healthCheck?.bind(llm),
    getModels: llm.getModels?.bind(llm),
  };
}

/** Capture usage at a non-streaming role or worker call boundary. */
export async function chatWithUsage(
  llm: ILlm,
  component: LlmComponent,
  messages: Message[],
  tools?: LlmTool[],
  options?: CallOptions,
) {
  const result = await chatResultWithUsage(
    llm,
    component,
    messages,
    tools,
    options,
  );
  if (!result.ok) throw result.error;
  return { ...result.value, usage: result.value.usage, model: llm.model };
}
