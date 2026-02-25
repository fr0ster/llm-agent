import type { Message } from '../../types.js';
import type { ISubpromptClassifier } from '../interfaces/classifier.js';
import type { ILlm } from '../interfaces/llm.js';
import {
  type ActionNode,
  type CallOptions,
  ClassifierError,
  type ClassifierResult,
  type Result,
  type SmartAgentError,
} from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LlmClassifierConfig {
  /** Cache results for identical input text within the instance lifetime. Default: true. */
  enableCache?: boolean;
  /** Prompt version tag logged for observability. Default: 'v2'. */
  promptVersion?: string;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const STORES_SYSTEM_PROMPT =
  'Given the user message, find what should be stored in memory.\n' +
  'Return ONLY a valid JSON object: {"stores":[{"type":"fact"|"feedback"|"state","text":"..."}]}\n' +
  'If nothing to store, return {"stores":[]}.';

const ACTIONS_SYSTEM_PROMPT =
  'Given the user message, find every action the user wants performed.\n' +
  'Build a dependency graph: if action B requires results from action A, set B.dependsOn=[A.id].\n' +
  'Independent actions have dependsOn:[].\n' +
  'Return ONLY a valid JSON object:\n' +
  '{"actions":[{"id":0,"text":"...","dependsOn":[]},{"id":1,"text":"...","dependsOn":[0]}]}\n' +
  'If nothing to do, return {"actions":[]}.';

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function stripCodeFence(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseStores(
  raw: string,
): Array<{ type: 'fact' | 'feedback' | 'state'; text: string }> {
  const cleaned = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClassifierError(
      `LLM returned non-JSON for stores: ${cleaned.slice(0, 120)}`,
      'PARSE_ERROR',
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).stores)
  ) {
    throw new ClassifierError(
      'LLM stores response missing "stores" array',
      'SCHEMA_ERROR',
    );
  }
  const stores = (parsed as Record<string, unknown>).stores as unknown[];
  const VALID_STORE_TYPES = new Set(['fact', 'feedback', 'state']);
  for (const entry of stores) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !VALID_STORE_TYPES.has((entry as Record<string, unknown>).type as string) ||
      typeof (entry as Record<string, unknown>).text !== 'string' ||
      ((entry as Record<string, unknown>).text as string).length === 0
    ) {
      throw new ClassifierError(
        `Invalid store entry: ${JSON.stringify(entry)}`,
        'SCHEMA_ERROR',
      );
    }
  }
  return stores as Array<{ type: 'fact' | 'feedback' | 'state'; text: string }>;
}

function parseActions(raw: string): ActionNode[] {
  const cleaned = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClassifierError(
      `LLM returned non-JSON for actions: ${cleaned.slice(0, 120)}`,
      'PARSE_ERROR',
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).actions)
  ) {
    throw new ClassifierError(
      'LLM actions response missing "actions" array',
      'SCHEMA_ERROR',
    );
  }
  const actions = (parsed as Record<string, unknown>).actions as unknown[];
  for (const entry of actions) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>).id !== 'number' ||
      typeof (entry as Record<string, unknown>).text !== 'string' ||
      ((entry as Record<string, unknown>).text as string).length === 0 ||
      !Array.isArray((entry as Record<string, unknown>).dependsOn)
    ) {
      throw new ClassifierError(
        `Invalid action entry: ${JSON.stringify(entry)}`,
        'SCHEMA_ERROR',
      );
    }
  }
  return actions as ActionNode[];
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
      signal.addEventListener('abort', () => reject(makeError()), { once: true });
    }),
  ]);
}

// ---------------------------------------------------------------------------
// LlmClassifier
// ---------------------------------------------------------------------------

export class LlmClassifier implements ISubpromptClassifier {
  private readonly promptVersion: string;
  private readonly cache: Map<string, ClassifierResult> | null;

  constructor(
    private readonly llm: ILlm,
    config?: LlmClassifierConfig,
  ) {
    this.promptVersion = config?.promptVersion ?? 'v2';
    this.cache = (config?.enableCache ?? true) ? new Map() : null;
  }

  async classify(
    text: string,
    options?: CallOptions,
  ): Promise<Result<ClassifierResult, ClassifierError>> {
    try {
      if (options?.signal?.aborted) {
        return { ok: false, error: new ClassifierError('Aborted', 'ABORTED') };
      }

      if (this.cache?.has(text)) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by has()
        return { ok: true, value: this.cache.get(text)! };
      }

      console.debug(
        `[LlmClassifier] classify promptVersion=${this.promptVersion}`,
      );

      const storesMessages: Message[] = [
        { role: 'system', content: STORES_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ];
      const actionsMessages: Message[] = [
        { role: 'system', content: ACTIONS_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ];

      // Both calls are independent — run in parallel
      const [storesLlmResult, actionsLlmResult] = await Promise.all([
        withAbort(
          this.llm.chat(storesMessages, [], options),
          options?.signal,
          () => new ClassifierError('Aborted', 'ABORTED'),
        ),
        withAbort(
          this.llm.chat(actionsMessages, [], options),
          options?.signal,
          () => new ClassifierError('Aborted', 'ABORTED'),
        ),
      ]);

      if (!storesLlmResult.ok) {
        const code =
          storesLlmResult.error.code === 'ABORTED' ? 'ABORTED' : 'LLM_ERROR';
        return {
          ok: false,
          error: new ClassifierError(storesLlmResult.error.message, code),
        };
      }
      if (!actionsLlmResult.ok) {
        const code =
          actionsLlmResult.error.code === 'ABORTED' ? 'ABORTED' : 'LLM_ERROR';
        return {
          ok: false,
          error: new ClassifierError(actionsLlmResult.error.message, code),
        };
      }

      const stores = parseStores(storesLlmResult.value.content);
      const actions = parseActions(actionsLlmResult.value.content);

      const result: ClassifierResult = { stores, actions };
      this.cache?.set(text, result);

      return { ok: true, value: result };
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
