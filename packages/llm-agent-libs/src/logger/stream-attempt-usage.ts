import {
  addTokenUsage,
  type IRequestLogger,
  type LlmUsage,
  type LlmUsageAttribution,
  type ModelUsageEntry,
} from '@mcp-abap-adt/llm-agent';

export class StreamAttemptUsage {
  private usage?: LlmUsage;
  private model?: string;

  add(usage: LlmUsage | undefined, model: string | undefined): void {
    if (usage || !this.usage) this.model = model ?? this.model;
    if (usage) this.usage = addTokenUsage(this.usage, usage);
  }

  resolve(
    fallbackModel: string | undefined,
    reported?: LlmUsageAttribution,
  ): LlmUsageAttribution {
    // Retry/error metadata describes the whole attempt, including streamed usage.
    if (reported?.usageByModel) return { usageByModel: reported.usageByModel };
    return {
      usage: reported?.usage ?? this.usage,
      model: reported?.model ?? this.model ?? fallbackModel,
    };
  }
}

export function modelUsageEntries(
  attribution: LlmUsageAttribution,
  countEmpty: boolean,
): [string, ModelUsageEntry][] {
  if (attribution.usageByModel) return Object.entries(attribution.usageByModel);
  if (!attribution.usage && !countEmpty) return [];
  return [
    [
      attribution.model ?? 'unknown',
      {
        ...(attribution.usage ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        }),
        requests: 1,
      },
    ],
  ];
}

export function logToolLoopAttempt(
  logger: IRequestLogger,
  attribution: LlmUsageAttribution,
  options: {
    requestId: string | undefined;
    durationMs: number;
    countEmpty?: boolean;
    onUsage?: (usage: LlmUsage) => void;
  },
): boolean {
  const entries = modelUsageEntries(attribution, options.countEmpty ?? false);
  for (const [model, usage] of entries) {
    logger.logLlmCall({
      ...usage,
      component: 'tool-loop',
      model,
      durationMs: attribution.usageByModel ? 0 : options.durationMs,
      requestId: options.requestId,
    });
    options.onUsage?.(usage);
  }
  return entries.length > 0;
}
