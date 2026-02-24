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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TYPES: ReadonlySet<string> = new Set<SubpromptType>([
  'fact',
  'feedback',
  'state',
  'action',
  'chat',
]);

export const DEFAULT_CLASSIFIER_PROMPT = `You are an intent classifier. Decompose the user message into one or more subprompts and classify each as:
  - "fact"     : critical technical constraints, rules, or domain knowledge (e.g. "ABAP Cloud forbids direct table access"). Store these for long-term reference.
  - "state"    : project context, team roles, or temporary environmental observations (e.g. "Kristina approves decisions", "Sky is blue", "It is raining"). These represent the current situation.
  - "feedback" : correction or evaluation of your previous response.
  - "action"   : a request to perform a task using tools (e.g. "Read table T100", "Brew coffee").
  - "chat"     : greetings, simple math, or small talk that doesn't need to be remembered (e.g. "Hello", "2+2").
Return ONLY a valid JSON array of { "type": "<type>", "text": "<subprompt text>" }.
If a message has multiple unrelated parts, split them into separate objects.`;

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

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
      `LLM returned non-JSON: ${cleaned.slice(0, 120)}`,
      'PARSE_ERROR',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ClassifierError(
      'LLM response is not a JSON array',
      'SCHEMA_ERROR',
    );
  }

  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !VALID_TYPES.has((entry as Record<string, unknown>).type as string) ||
      typeof (entry as Record<string, unknown>).text !== 'string' ||
      ((entry as Record<string, unknown>).text as string).length === 0
    ) {
      throw new ClassifierError(
        `Invalid subprompt entry: ${JSON.stringify(entry)}`,
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
// LlmClassifier
// ---------------------------------------------------------------------------

export class LlmClassifier implements ISubpromptClassifier {
  private readonly systemPrompt: string;
  private readonly promptVersion: string;
  private readonly cache: Map<string, Subprompt[]> | null;

  constructor(
    private readonly llm: ILlm,
    config?: LlmClassifierConfig,
  ) {
    this.systemPrompt = config?.systemPrompt ?? DEFAULT_CLASSIFIER_PROMPT;
    this.promptVersion = config?.promptVersion ?? 'v1';
    this.cache = (config?.enableCache ?? true) ? new Map() : null;
  }

  async classify(
    text: string,
    options?: CallOptions,
  ): Promise<Result<Subprompt[], ClassifierError>> {
    try {
      if (options?.signal?.aborted) {
        return {
          ok: false,
          error: new ClassifierError('Aborted', 'ABORTED'),
        };
      }

      if (this.cache?.has(text)) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by has()
        return { ok: true, value: this.cache.get(text)! };
      }

      const messages: Message[] = [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: text },
      ];

      console.debug(
        `[LlmClassifier] classify promptVersion=${this.promptVersion}`,
      );

      const llmResult = await withAbort(
        this.llm.chat(messages, [], options),
        options?.signal,
        () => new ClassifierError('Aborted', 'ABORTED'),
      );

      if (!llmResult.ok) {
        const code =
          llmResult.error.code === 'ABORTED' ? 'ABORTED' : 'LLM_ERROR';
        return {
          ok: false,
          error: new ClassifierError(llmResult.error.message, code),
        };
      }

      const subprompts = parseSubprompts(llmResult.value.content);

      this.cache?.set(text, subprompts);

      return { ok: true, value: subprompts };
    } catch (err) {
      if (err instanceof ClassifierError) {
        return { ok: false, error: err };
      }
      return {
        ok: false,
        error: new ClassifierError(String(err), 'LLM_ERROR'),
      };
    }
  }
}
