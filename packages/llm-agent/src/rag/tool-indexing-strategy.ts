import type { ILlm } from '../interfaces/llm.js';
import type { IRequestLogger } from '../interfaces/request-logger.js';
import type { CallOptions } from '../interfaces/types.js';

/**
 * A tool description to be indexed in RAG.
 */
export interface IToolDescriptor {
  name: string;
  description: string;
}

/**
 * A text variant to upsert into RAG. Each variant gets its own embedding.
 * Multiple variants per tool = broader recall.
 */
export interface IToolIndexEntry {
  /** RAG record id. Format: tool:<name>[:<suffix>] */
  id: string;
  /** Text to embed and store. */
  text: string;
}

/**
 * Generates text variants for tool indexing in RAG.
 * Each strategy produces one or more entries per tool.
 * Strategies can be combined — builder upserts all entries from all strategies.
 */
export interface IToolIndexingStrategy {
  readonly name: string;
  prepare(
    tool: IToolDescriptor,
    options?: CallOptions,
  ): Promise<IToolIndexEntry[]>;
}

// ---------------------------------------------------------------------------
// Original — current behavior: "Tool: name — description"
// ---------------------------------------------------------------------------

/**
 * Indexes the raw tool description as-is.
 * This is the current default behavior.
 */
export class OriginalToolIndexing implements IToolIndexingStrategy {
  readonly name = 'original';

  async prepare(tool: IToolDescriptor): Promise<IToolIndexEntry[]> {
    return [
      {
        id: `tool:${tool.name}`,
        text: `${tool.name}: ${tool.description}`,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Intent — LLM generates concise keyword phrases
// ---------------------------------------------------------------------------

const INTENT_PROMPT = `You receive a tool description with its name and parameters.
Extract the core INTENT in 3-5 short keyword phrases that a user would type when needing this tool.
Focus on WHAT the tool does, not HOW. Use simple action words.

Format: return ONLY the keyword phrases separated by commas, no explanation.

Examples:
- Input: "GetTableContents: Retrieve contents (data preview) of an ABAP database table or CDS view."
  Output: table data preview, read table contents, SE16 data, select from table, show table rows

- Input: "SearchObject: Find, search, locate, or check if an ABAP repository object exists by name or wildcard pattern."
  Output: search object by name, find ABAP object, locate program class table, does object exist, wildcard search`;

/**
 * LLM generates concise intent keywords for the tool.
 * Indexed alongside the original for broader keyword coverage.
 */
export class IntentToolIndexing implements IToolIndexingStrategy {
  readonly name = 'intent';

  constructor(
    private readonly llm: ILlm,
    private readonly requestLogger?: IRequestLogger,
  ) {}

  async prepare(
    tool: IToolDescriptor,
    options?: CallOptions,
  ): Promise<IToolIndexEntry[]> {
    const inputText = `${tool.name}: ${tool.description}`;
    try {
      const chatStart = Date.now();
      const res = await this.llm.chat(
        [
          { role: 'system' as const, content: INTENT_PROMPT },
          { role: 'user' as const, content: inputText },
        ],
        [],
        options,
      );
      if (this.requestLogger) {
        this.requestLogger.logLlmCall({
          component: 'helper',
          model: this.llm.model ?? 'unknown',
          promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
          completionTokens: res.ok
            ? (res.value.usage?.completionTokens ?? 0)
            : 0,
          totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
          durationMs: Date.now() - chatStart,
        });
      }

      if (!res.ok || !res.value.content.trim()) return [];

      return [
        {
          id: `tool:${tool.name}:intent`,
          text: `${tool.name}: ${res.value.content.trim()}`,
        },
      ];
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Synonym — adds action verb synonyms
// ---------------------------------------------------------------------------

const ACTION_SYNONYMS: Record<string, string[]> = {
  read: ['show', 'display', 'view', 'get', 'retrieve'],
  create: ['add', 'new', 'make', 'generate'],
  update: ['modify', 'change', 'edit', 'set'],
  delete: ['remove', 'drop', 'destroy'],
  search: ['find', 'locate', 'lookup', 'discover'],
  list: ['show all', 'enumerate', 'browse'],
  run: ['execute', 'start', 'launch', 'trigger'],
  check: ['validate', 'verify', 'test', 'inspect'],
  get: ['read', 'fetch', 'retrieve', 'show'],
  activate: ['enable', 'publish', 'deploy'],
};

/**
 * Adds action verb synonyms to the tool description.
 * E.g. "ReadClass" → also indexed with "show class, display class, view class".
 * Purely deterministic — no LLM needed.
 */
export class SynonymToolIndexing implements IToolIndexingStrategy {
  readonly name = 'synonym';

  async prepare(tool: IToolDescriptor): Promise<IToolIndexEntry[]> {
    const nameLower = tool.name.toLowerCase();
    const synonymPhrases: string[] = [];

    for (const [verb, synonyms] of Object.entries(ACTION_SYNONYMS)) {
      if (nameLower.startsWith(verb)) {
        const objectPart = tool.name
          .replace(/^[A-Z][a-z]+/, '') // Remove first word (the verb)
          .replace(/([A-Z])/g, ' $1') // CamelCase to spaces
          .trim()
          .toLowerCase();
        if (objectPart) {
          for (const syn of synonyms) {
            synonymPhrases.push(`${syn} ${objectPart}`);
          }
        }
        break;
      }
    }

    if (synonymPhrases.length === 0) return [];

    return [
      {
        id: `tool:${tool.name}:synonym`,
        text: `${tool.name}: ${synonymPhrases.join(', ')}`,
      },
    ];
  }
}
