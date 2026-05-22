import type {
  ISubAgentContextBuilder,
  RagResult,
  SubAgentContextRequest,
  SubAgentContextResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Thin retrieval callback used by the builder. The caller is responsible
 * for converting `text` into whatever the underlying store needs
 * (typically: wrap text + embedder in QueryEmbedding, then call
 * `IRag.query(embedding, k, options)`), but the builder itself stays
 * decoupled from embedder/RAG specifics.
 */
export type SubAgentRetrievalSource = (
  text: string,
  k: number,
  signal?: AbortSignal,
) => Promise<RagResult[]>;

export interface DefaultSubAgentContextBuilderConfig {
  /** Source of project/domain knowledge snippets. */
  projectSource?: SubAgentRetrievalSource;
  /** Source of tool-description / MCP-RAG snippets. */
  toolSource?: SubAgentRetrievalSource;
  topKProject?: number;
  topKTool?: number;
  maxContextChars?: number;
}

const DEFAULT_TOP_K_PROJECT = 3;
const DEFAULT_TOP_K_TOOL = 3;
const DEFAULT_MAX_CHARS = 4000;

/**
 * Builds subagent context by querying project source, then tool source.
 * Skips retrieval entirely when the agent's contextPolicy is 'forbidden'.
 * Bounds the final context by character budget (cheap proxy for tokens).
 */
export class DefaultSubAgentContextBuilder implements ISubAgentContextBuilder {
  constructor(private readonly config: DefaultSubAgentContextBuilderConfig) {}

  async build(req: SubAgentContextRequest): Promise<SubAgentContextResult> {
    if (req.agent.capabilities.contextPolicy === 'forbidden') {
      return { context: '', sources: [] };
    }

    const sources: SubAgentContextResult['sources'] = [];
    const parts: string[] = [];

    const topKProject = this.config.topKProject ?? DEFAULT_TOP_K_PROJECT;
    const topKTool = this.config.topKTool ?? DEFAULT_TOP_K_TOOL;
    const maxChars = this.config.maxContextChars ?? DEFAULT_MAX_CHARS;

    if (this.config.projectSource) {
      try {
        const results = await this.config.projectSource(
          req.task,
          topKProject,
          req.signal,
        );
        for (const r of results.slice(0, topKProject)) {
          parts.push(r.text);
          sources.push({
            kind: 'rag',
            ref: this.refOf(r, 'path') ?? 'unknown',
          });
        }
      } catch {
        // Retrieval errors are non-fatal — caller observes empty source.
      }
    }

    if (this.config.toolSource) {
      try {
        const results = await this.config.toolSource(
          req.task,
          topKTool,
          req.signal,
        );
        for (const r of results.slice(0, topKTool)) {
          parts.push(r.text);
          sources.push({
            kind: 'tool-rag',
            ref: this.refOf(r, 'tool') ?? 'unknown',
          });
        }
      } catch {
        // Same policy as projectSource.
      }
    }

    let context = parts.join('\n\n');
    if (context.length > maxChars) {
      context = `${context.slice(0, maxChars)}…`;
    }

    return { context, sources };
  }

  private refOf(r: RagResult, key: string): string | undefined {
    const meta = r.metadata as Record<string, unknown> | undefined;
    const value = meta?.[key];
    return typeof value === 'string' ? value : undefined;
  }
}
