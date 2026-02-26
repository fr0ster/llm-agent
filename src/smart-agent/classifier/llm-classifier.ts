import type { Message } from '../../types.js';
import type { ISubpromptClassifier } from '../interfaces/classifier.js';
import type { ILlm } from '../interfaces/llm.js';
import {
  type CallOptions,
  ClassifierError,
  type Result,
  type SmartAgentError,
  type Subprompt,
  type SubpromptType,
} from '../interfaces/types.js';

const VALID_TYPES: ReadonlySet<string> = new Set<SubpromptType>([
  'fact',
  'feedback',
  'state',
  'action',
  'chat',
]);

export const DEFAULT_CLASSIFIER_PROMPT = `You are a Semantic Intent Analyzer. Decompose the user message into logical tasks.
For each task, identify:
  - "type": chat (greetings/math), action (tasks), fact (knowledge), state (context), feedback.
  - "text": the actual task description.
  - "context": the domain of the task (e.g., "sap-abap", "math", "general").
  - "dependency": "independent" or "coupled" (if it's part of a conditional chain).

CRITICAL RULES:
1. If tasks are conditionally linked (e.g., "Do A, and IF it fails then do B"), KEEP THEM TOGETHER in one "action" subprompt.
2. If tasks are independent (e.g., "Check weather AND add 5+5"), SPLIT them.
3. Be strictly neutral. Only assign "sap-abap" context if SAP terms are present.

Example: "Read table T100, if fails then read its structure. Also tell me a joke."
Result: [
  {"type": "action", "text": "Read content of table T100, if not possible read its structure", "context": "sap-abap", "dependency": "independent"},
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
      !VALID_TYPES.has(entry.type) ||
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

function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  makeError: () => SmartAgentError,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(makeError()), {
        once: true,
      });
    }),
  ]);
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
  ) {
    this.systemPrompt = config?.systemPrompt ?? DEFAULT_CLASSIFIER_PROMPT;
    this.cache = (config?.enableCache ?? true) ? new Map() : null;
  }

  async classify(
    text: string,
    options?: CallOptions,
  ): Promise<Result<Subprompt[], ClassifierError>> {
    try {
      if (options?.signal?.aborted)
        return { ok: false, error: new ClassifierError('Aborted', 'ABORTED') };
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
      const llmResult = await withAbort(
        this.llm.chat(messages, [], options),
        options?.signal,
        () => new ClassifierError('Aborted', 'ABORTED'),
      );
      if (!llmResult.ok)
        return {
          ok: false,
          error: new ClassifierError(llmResult.error.message, 'LLM_ERROR'),
        };

      const subprompts = parseSubprompts(llmResult.value.content);
      this.cache?.set(text, subprompts);
      return { ok: true, value: subprompts };
    } catch (err) {
      if (err instanceof ClassifierError) return { ok: false, error: err };
      return {
        ok: false,
        error: new ClassifierError(String(err), 'LLM_ERROR'),
      };
    }
  }
}
