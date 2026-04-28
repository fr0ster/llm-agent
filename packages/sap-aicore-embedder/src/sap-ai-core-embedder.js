import { FoundationModelsEmbedder, } from './foundation-embedder.js';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';
export class SapAiCoreEmbedder {
    backend;
    constructor(config) {
        const scenario = config.scenario ?? 'orchestration';
        if (scenario === 'orchestration') {
            this.backend = new OrchestrationScenarioEmbedder({
                model: config.model,
                resourceGroup: config.resourceGroup,
            });
        }
        else {
            this.backend = new FoundationModelsEmbedder({
                model: config.model,
                resourceGroup: config.resourceGroup,
                credentials: config.credentials,
            });
        }
    }
    embed(text, options) {
        return this.backend.embed(text, options);
    }
    embedBatch(texts, options) {
        return this.backend.embedBatch(texts, options);
    }
}
//# sourceMappingURL=sap-ai-core-embedder.js.map