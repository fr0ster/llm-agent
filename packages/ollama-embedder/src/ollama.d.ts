import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, VectorRag, type VectorRagConfig } from '@mcp-abap-adt/llm-agent';
export interface OllamaEmbedderConfig {
    /** Default: 'http://localhost:11434' */
    ollamaUrl?: string;
    /** Default: 'nomic-embed-text' */
    model?: string;
    /** Per-request timeout in milliseconds. Default: 30 000 */
    timeoutMs?: number;
}
export declare class OllamaEmbedder implements IEmbedderBatch {
    private readonly ollamaUrl;
    private readonly model;
    private readonly timeoutMs;
    constructor(config?: OllamaEmbedderConfig);
    embed(text: string, options?: CallOptions): Promise<IEmbedResult>;
    embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]>;
}
/**
 * OllamaRag — convenience adapter that combines OllamaEmbedder with VectorRag.
 */
export declare class OllamaRag extends VectorRag {
    constructor(config?: OllamaEmbedderConfig & VectorRagConfig);
}
//# sourceMappingURL=ollama.d.ts.map