import type {
  IToolSelectionStrategy,
  RagResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Keeps only results whose cosine score is at or above `minScore`. A query
 * whose nearest tools all score below the cutoff yields an empty set, so no
 * tools are surfaced and the LLM answers as plain chat — semantic distance
 * decides both which tools and whether any, with no classifier gate.
 *
 * `minScore` is embedder-dependent and is the deployment's choice.
 */
export class ScoreThresholdToolSelection implements IToolSelectionStrategy {
  readonly name = 'threshold';
  constructor(private readonly minScore: number) {}
  select(results: RagResult[]): RagResult[] {
    return results.filter((r) => r.score >= this.minScore);
  }
}
