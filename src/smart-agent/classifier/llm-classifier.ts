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
  'fact', 'feedback', 'state', 'action', 'chat',
]);

export const DEFAULT_CLASSIFIER_PROMPT = `You are a Semantic Intent Analyzer. Decompose the user message into logical tasks.
For each task, identify:
  - "type": chat (greetings/math), action (tasks), fact (knowledge), state (context), feedback.
  - "text": the actual task description.
  - "context": the domain of the task (e.g., "sap-abap", "math", "general-knowledge").
  - "dependency": "independent" or the "text" of the task this depends on.

Example: "Read T002 and add 5+9"
Result: [
  {"type": "action", "text": "Read structure of table T002", "context": "sap-abap", "dependency": "independent"},
  {"type": "chat", "text": "Add 5 and 9", "context": "math", "dependency": "independent"}
]

Return ONLY a JSON array. Be strictly neutral. Do not assume everything is SAP ABAP unless it explicitly mentions SAP terms.`;

function stripCodeFence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function parseSubprompts(raw: string): Subprompt[] {
  const cleaned = stripCodeFence(raw);
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch { throw new ClassifierError(`Non-JSON: ${cleaned.slice(0, 120)}`, 'PARSE_ERROR'); }
  if (!Array.isArray(parsed)) throw new ClassifierError('Not a JSON array', 'SCHEMA_ERROR');
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || !VALID_TYPES.has(entry.type) || typeof entry.text !== 'string' || entry.text.length === 0) {
      throw new ClassifierError(`Invalid entry: ${JSON.stringify(entry)}`, 'SCHEMA_ERROR');
    }
  }
  return parsed as Subprompt[];
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, makeError: () => SmartAgentError): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  return Promise.race([promise, new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(makeError()), { once: true }); })]);
}

export class LlmClassifier implements ISubpromptClassifier {
  private readonly systemPrompt: string;
  private readonly cache: Map<string, Subprompt[]> | null;

  constructor(private readonly llm: ILlm, config?: { systemPrompt?: string; enableCache?: boolean }) {
    this.systemPrompt = config?.systemPrompt ?? DEFAULT_CLASSIFIER_PROMPT;
    this.cache = (config?.enableCache ?? true) ? new Map() : null;
  }

  async classify(text: string, options?: CallOptions): Promise<Result<Subprompt[], ClassifierError>> {
    try {
      if (options?.signal?.aborted) return { ok: false, error: new ClassifierError('Aborted', 'ABORTED') };
      if (this.cache?.has(text)) return { ok: true, value: this.cache.get(text)! };

      const messages: Message[] = [{ role: 'system', content: this.systemPrompt }, { role: 'user', content: text }];
      const llmResult = await withAbort(this.llm.chat(messages, [], options), options?.signal, () => new ClassifierError('Aborted', 'ABORTED'));
      if (!llmResult.ok) return { ok: false, error: new ClassifierError(llmResult.error.message, 'LLM_ERROR') };

      const subprompts = parseSubprompts(llmResult.value.content);
      this.cache?.set(text, subprompts);
      return { ok: true, value: subprompts };
    } catch (err) {
      if (err instanceof ClassifierError) return { ok: false, error: err };
      return { ok: false, error: new ClassifierError(String(err), 'LLM_ERROR') };
    }
  }
}
