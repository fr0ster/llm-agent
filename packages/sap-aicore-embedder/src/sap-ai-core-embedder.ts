import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  CallOptions,
  IDocumentEmbedder,
  IEmbedderBatch,
  IEmbedResult,
  IQueryEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { FoundationModelsEmbedder } from './foundation-embedder.js';
import {
  OrchestrationScenarioEmbedder,
  type SapAiCoreEmbedderInputType,
} from './orchestration-embedder.js';

export type SapAiCoreEmbedderScenario = 'foundation-models' | 'orchestration';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small', 'gemini-embedding') */
  model: string;
  /** SAP AI Core resource group. Default: 'default'. */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario under which the embedding model is deployed.
   * - `'orchestration'` (default): uses `OrchestrationEmbeddingClient` from `@sap-ai-sdk/orchestration`.
   *   Requires an orchestration-scenario deployment of the embedding model. This matches v11.0.0 behavior.
   * - `'foundation-models'`: calls the AI Core REST inference API directly.
   *   Use this when your embedding models are deployed under the foundation-models scenario
   *   (common for tenants where SAP AI Core embedders such as `gemini-embedding` and `text-embedding-3-small`
   *   are deployed outside the orchestration scenario).
   */
  scenario?: SapAiCoreEmbedderScenario;
  /**
   * The bearer credential presented to SAP AI Core, for both scenarios.
   * Resolved fresh per call by the backend — never cached here. Build one
   * from a service key with `serviceKeyCredential` (`@mcp-abap-adt/sap-aicore-auth`).
   */
  credential: IBearerCredential;
  /**
   * SAP AI Core base URL (orchestration or REST inference, depending on
   * `scenario`). Not part of the credential (§4.6.3).
   */
  apiBaseUrl: string;
  /**
   * The input `type` an asymmetric retrieval model requires (`document` for
   * stored text, `query` for search text). Orchestration scenario only; unset,
   * none is sent. Prefer {@link SapAiCoreDocumentEmbedder} /
   * {@link SapAiCoreQueryEmbedder}, which fix it and carry the role type.
   */
  inputType?: SapAiCoreEmbedderInputType;
}

export class SapAiCoreEmbedder implements IEmbedderBatch {
  private readonly backend: IEmbedderBatch;

  constructor(config: SapAiCoreEmbedderConfig) {
    const scenario = config.scenario ?? 'orchestration';
    if (config.inputType !== undefined && scenario !== 'orchestration') {
      // Said and not supported is an error, not a silent drop.
      throw new Error(
        `SapAiCoreEmbedder: inputType is supported with scenario 'orchestration' only, not '${scenario}'`,
      );
    }
    if (scenario === 'orchestration') {
      this.backend = new OrchestrationScenarioEmbedder({
        model: config.model,
        resourceGroup: config.resourceGroup,
        credential: config.credential,
        apiBaseUrl: config.apiBaseUrl,
        ...(config.inputType !== undefined
          ? { inputType: config.inputType }
          : {}),
      });
    } else {
      this.backend = new FoundationModelsEmbedder({
        model: config.model,
        resourceGroup: config.resourceGroup,
        credential: config.credential,
        apiBaseUrl: config.apiBaseUrl,
      });
    }
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.backend.embed(text, options);
  }

  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]> {
    return this.backend.embedBatch(texts, options);
  }
}

/**
 * The DOCUMENT half of an asymmetric pair: embeds stored text with
 * `type: document`. Build it beside a {@link SapAiCoreQueryEmbedder} on the same
 * model; the role type keeps the two from being swapped.
 */
export class SapAiCoreDocumentEmbedder
  extends SapAiCoreEmbedder
  implements IDocumentEmbedder
{
  declare readonly embedderRole: 'document';

  constructor(config: Omit<SapAiCoreEmbedderConfig, 'inputType'>) {
    super({ ...config, inputType: 'document' });
  }
}

/** The QUERY half of an asymmetric pair: embeds search text with `type: query`. */
export class SapAiCoreQueryEmbedder
  extends SapAiCoreEmbedder
  implements IQueryEmbedder
{
  declare readonly embedderRole: 'query';

  constructor(config: Omit<SapAiCoreEmbedderConfig, 'inputType'>) {
    super({ ...config, inputType: 'query' });
  }
}
