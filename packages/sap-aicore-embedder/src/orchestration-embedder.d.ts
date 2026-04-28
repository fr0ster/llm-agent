import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions } from '@mcp-abap-adt/llm-agent';
export interface OrchestrationScenarioEmbedderConfig {
  model: string;
  resourceGroup?: string;
}
export declare class OrchestrationScenarioEmbedder implements IEmbedderBatch {
  private readonly model;
  private readonly resourceGroup?;
  constructor(config: OrchestrationScenarioEmbedderConfig);
  embed(text: string, _options?: CallOptions): Promise<IEmbedResult>;
  embedBatch(texts: string[], _options?: CallOptions): Promise<IEmbedResult[]>;
  private createClient;
}
//# sourceMappingURL=orchestration-embedder.d.ts.map
