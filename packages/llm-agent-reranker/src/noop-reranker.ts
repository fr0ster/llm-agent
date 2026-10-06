import type {
  CallOptions,
  IReranker,
  RagError,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

export class NoopReranker implements IReranker {
  async rerank(
    _query: string,
    results: RagResult[],
    _options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    return { ok: true, value: results };
  }
}
