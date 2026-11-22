import { randomUUID } from 'node:crypto';
import {
  addTokenUsage,
  type IRequestLogger,
  type LlmCallRecord,
  type LlmComponent,
  type LlmUsage,
  type LlmUsageAttribution,
} from '@mcp-abap-adt/llm-agent';
import {
  errorUsage,
  usageCallRecords,
  withUsageCalls,
} from './llm-call-usage.js';

/** A stream attempt owns its id until a retry reset closes the attempt. */
export class StreamAttemptUsage {
  private callId = randomUUID();
  private usage?: LlmUsage;
  private readonly usageCalls = new Map<string, LlmCallRecord>();
  private model?: string;
  private awaitingRetry = false;
  private startedAt = Date.now();

  add(
    usage: LlmUsage | undefined,
    model: string | undefined,
    usageCalls?: readonly LlmCallRecord[],
  ): void {
    for (const call of usageCalls ?? []) {
      if (!this.usageCalls.has(call.callId))
        this.usageCalls.set(call.callId, call);
    }
    this.awaitingRetry = false;
    if (usage || !this.usage) this.model = model ?? this.model;
    if (usage) this.usage = addTokenUsage(this.usage, usage);
  }

  reset(): void {
    this.callId = randomUUID();
    this.usage = undefined;
    this.usageCalls.clear();
    this.model = undefined;
    this.awaitingRetry = true;
    this.startedAt = Date.now();
  }

  resolve(
    fallbackModel: string | undefined,
    reported?: LlmUsageAttribution,
  ): LlmUsageAttribution {
    // Retry/error metadata describes the whole attempt, including streamed usage.
    return {
      usageCalls:
        reported?.usageCalls ??
        (this.usageCalls.size > 0 ? [...this.usageCalls.values()] : undefined),
      usageByModel: reported?.usageByModel,
      usage: reported?.usage ?? this.usage,
      model: reported?.model ?? this.model ?? fallbackModel,
    };
  }

  records(
    component: LlmComponent,
    fallbackModel: string | undefined,
    reported?: LlmUsageAttribution,
    signal?: AbortSignal,
    countEmpty = true,
  ): readonly LlmCallRecord[] {
    if (
      this.awaitingRetry &&
      signal?.aborted &&
      !reported?.usage &&
      !reported?.usageByModel &&
      !reported?.usageCalls &&
      !reported?.model
    ) {
      return [];
    }
    return usageCallRecords(
      this.resolve(fallbackModel, reported),
      component,
      Date.now() - this.startedAt,
      this.callId,
      countEmpty,
    );
  }
}

/** A provider may throw instead of yielding an error result. */
export async function* recordThrownLlmUsage<T>(
  run: () => AsyncIterable<T>,
  record: (attribution: LlmUsageAttribution) => readonly LlmCallRecord[],
): AsyncIterable<T> {
  try {
    yield* run();
  } catch (error) {
    throw withUsageCalls(error, record(errorUsage(error)));
  }
}

export function logToolLoopAttempt(
  logger: IRequestLogger,
  calls: readonly LlmCallRecord[],
  requestId: string | undefined,
  onUsage?: (usage: LlmUsage) => void,
): void {
  for (const call of calls) {
    logger.logLlmCall({ ...call, requestId });
    onUsage?.(call);
  }
}
