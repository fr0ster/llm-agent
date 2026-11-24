import type {
  ILlm,
  IRequestLogger,
  ISubpromptClassifier,
  LlmUsageAttribution,
  Message,
} from '@mcp-abap-adt/llm-agent';
import {
  abortRunError,
  type CallOptions,
  ClassifierError,
  copyErrorUsage,
  errorUsage,
  overflowError,
  type Result,
  type Subprompt,
  toAbortError,
} from '@mcp-abap-adt/llm-agent';
import { usageCallRecords } from '../logger/llm-call-usage.js';
import { withAbort } from '../utils/with-abort.js';

export const DEFAULT_CLASSIFIER_PROMPT = `You are a Semantic Intent Analyzer. Decompose the user message into logical tasks.
For each task, identify:
  - "type": chat (greetings, simple questions, math), action (tasks requiring tools or execution).
  - "text": the actual task description.
  - "context": the domain of the task (e.g., "sap-abap", "math", "general").
  - "dependency": "independent", "sequential" (must run after previous action), or an ID of a subprompt this one depends on.

CRITICAL RULES:
1. If a message contains multiple sequential steps (e.g., "Do A and then check B"), SPLIT them into separate "action" subprompts with "dependency": "sequential" on the later steps.
2. If tasks are independent (e.g., "Check weather AND add 5+5"), SPLIT them with "dependency": "independent".
3. If a task is an atomic operation with a conditional fallback (e.g., "Do A, if it fails do B"), keep it as a SINGLE subprompt — the fallback is part of the same instruction.
4. Be strictly neutral. Only assign "sap-abap" context if SAP terms are present.

Example: "Read table T100 and check its transport history. Also tell me a joke."
Result: [
  {"type": "action", "text": "Read content of table T100", "context": "sap-abap", "dependency": "independent"},
  {"type": "action", "text": "Check transport history of table T100", "context": "sap-abap", "dependency": "sequential"},
  {"type": "chat", "text": "Tell a joke", "context": "general", "dependency": "independent"}
]

Return ONLY a JSON array.`;

function stripCodeFence(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseSubprompts(raw: string): Subprompt[] {
  const cleaned = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClassifierError(
      `Non-JSON: ${cleaned.slice(0, 120)}`,
      'PARSE_ERROR',
    );
  }
  if (!Array.isArray(parsed))
    throw new ClassifierError('Not a JSON array', 'SCHEMA_ERROR');
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.type !== 'string' ||
      entry.type.length === 0 ||
      typeof entry.text !== 'string' ||
      entry.text.length === 0
    ) {
      throw new ClassifierError(
        `Invalid entry: ${JSON.stringify(entry)}`,
        'SCHEMA_ERROR',
      );
    }
  }
  return parsed as Subprompt[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LlmClassifierConfig {
  /** Override default system prompt. */
  systemPrompt?: string;
  /** Prompt version tag logged for observability. Default: 'v1'. */
  promptVersion?: string;
  /** Cache results for identical input text within the instance lifetime. Default: true. */
  enableCache?: boolean;
}

export class LlmClassifier implements ISubpromptClassifier {
  private readonly systemPrompt: string;
  private readonly cache: Map<string, Subprompt[]> | null;

  constructor(
    private readonly llm: ILlm,
    config?: LlmClassifierConfig,
    private readonly requestLogger?: IRequestLogger,
  ) {
    this.systemPrompt = config?.systemPrompt ?? DEFAULT_CLASSIFIER_PROMPT;
    this.cache = (config?.enableCache ?? true) ? new Map() : null;
  }

  async classify(
    text: string,
    options?: CallOptions,
  ): Promise<Result<Subprompt[], ClassifierError>> {
    let chatStart: number | undefined;
    const logger = options?.requestLogger ?? this.requestLogger;
    try {
      options?.signal?.throwIfAborted();
      if (this.cache?.has(text)) {
        const cached = this.cache.get(text);
        if (cached) {
          return { ok: true, value: cached };
        }
      }

      const messages: Message[] = [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: text },
      ];
      chatStart = Date.now();
      const llmResult = await withAbort(
        this.llm.chat(messages, [], {
          ...options,
          usage: options?.usage?.with({ role: 'classifier' }),
        }),
        options?.signal,
        () => abortRunError(options?.signal?.reason),
      );
      const durationMs = Date.now() - chatStart;
      chatStart = undefined;
      if (logger) {
        this.logUsage(
          logger,
          llmResult.ok ? llmResult.value : errorUsage(llmResult.error),
          durationMs,
          options,
          true,
        );
      }
      if (!llmResult.ok) {
        const { error } = llmResult;
        return {
          ok: false,
          error: copyErrorUsage(
            toAbortError(error, options?.signal) ??
              overflowError(error) ??
              new ClassifierError(error.message, error.code),
            error,
          ),
        };
      }

      const subprompts = parseSubprompts(llmResult.value.content);
      this.cache?.set(text, subprompts);
      return { ok: true, value: subprompts };
    } catch (error) {
      if (logger && chatStart !== undefined) {
        this.logUsage(
          logger,
          errorUsage(error),
          Date.now() - chatStart,
          options,
          false,
        );
      }
      return {
        ok: false,
        error: copyErrorUsage(
          toAbortError(error, options?.signal) ??
            overflowError(error) ??
            (error instanceof ClassifierError
              ? error
              : new ClassifierError(String(error), 'LLM_ERROR')),
          error,
        ),
      };
    }
  }

  private logUsage(
    logger: IRequestLogger,
    attribution: LlmUsageAttribution,
    durationMs: number,
    options: CallOptions | undefined,
    countEmpty: boolean,
  ): void {
    for (const call of usageCallRecords(
      { ...attribution, model: attribution.model ?? this.llm.model },
      'classifier',
      durationMs,
      undefined,
      countEmpty,
    )) {
      logger.logLlmCall({ ...call, requestId: options?.trace?.traceId });
    }
  }
}
