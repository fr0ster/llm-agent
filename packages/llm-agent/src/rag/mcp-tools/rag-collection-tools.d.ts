import { z } from 'zod';
import type {
  IRagProviderRegistry,
  IRagRegistry,
} from '../../interfaces/rag.js';
export interface RagToolContext {
  sessionId?: string;
  userId?: string;
  [key: string]: unknown;
}
export interface RagToolEntry {
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (
    context: RagToolContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}
export declare function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
  providerRegistry?: IRagProviderRegistry;
}): RagToolEntry[];
//# sourceMappingURL=rag-collection-tools.d.ts.map
