import { RagError } from '@mcp-abap-adt/llm-agent';
import { TokenProvider } from './auth.js';
import { decodeEmbedding } from './decode-embedding.js';
import { resolveDeploymentId } from './deployments.js';
import { parseServiceKey } from './service-key.js';
export class FoundationModelsEmbedder {
    model;
    family;
    azureApiVersion;
    resourceGroup;
    apiBaseUrl;
    tokenProvider;
    deploymentIdPromise = null;
    constructor(config) {
        const creds = config.credentials ?? this.loadCredentialsFromEnv();
        this.model = config.model;
        this.family = detectFamily(config.model);
        this.azureApiVersion = config.azureApiVersion ?? '2023-05-15';
        this.resourceGroup = config.resourceGroup ?? 'default';
        this.apiBaseUrl = creds.apiBaseUrl;
        this.tokenProvider = new TokenProvider({
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            tokenUrl: creds.tokenUrl,
        });
    }
    async embed(text, _options) {
        const items = await this.requestEmbeddings([text]);
        if (items.length === 0) {
            throw new RagError('No embeddings returned from SAP AI Core');
        }
        return { vector: decodeEmbedding(items[0].embedding) };
    }
    async embedBatch(texts, _options) {
        if (texts.length === 0)
            return [];
        const items = await this.requestEmbeddings(texts);
        if (items.length === 0) {
            throw new RagError('No embeddings returned from SAP AI Core batch');
        }
        const sorted = [...items].sort((a, b) => a.index - b.index);
        return sorted.map((item) => ({ vector: decodeEmbedding(item.embedding) }));
    }
    async requestEmbeddings(input) {
        const token = await this.tokenProvider.getToken();
        const deploymentId = await this.getDeploymentId(token);
        const base = `${this.apiBaseUrl}/v2/inference/deployments/${deploymentId}`;
        const headers = {
            Authorization: `Bearer ${token}`,
            'AI-Resource-Group': this.resourceGroup,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
        if (this.family === 'gemini') {
            const url = `${base}/models/${encodeURIComponent(this.model)}:predict`;
            const body = {
                instances: input.map((content) => ({ content })),
            };
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new RagError(`SAP AI Core embeddings call failed: ${res.status} ${res.statusText} ${text}`);
            }
            const json = (await res.json());
            return (json.predictions ?? []).map((p, i) => ({
                embedding: p.embeddings?.values ?? [],
                index: i,
            }));
        }
        // azure-openai
        const url = `${base}/embeddings?api-version=${encodeURIComponent(this.azureApiVersion)}`;
        const body = { input: input.length === 1 ? input[0] : input };
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new RagError(`SAP AI Core embeddings call failed: ${res.status} ${res.statusText} ${text}`);
        }
        const json = (await res.json());
        return json.data ?? [];
    }
    getDeploymentId(token) {
        if (!this.deploymentIdPromise) {
            this.deploymentIdPromise = resolveDeploymentId({
                apiBaseUrl: this.apiBaseUrl,
                token,
                resourceGroup: this.resourceGroup,
                model: this.model,
            }).catch((err) => {
                this.deploymentIdPromise = null;
                throw err;
            });
        }
        return this.deploymentIdPromise;
    }
    loadCredentialsFromEnv() {
        const raw = process.env.AICORE_SERVICE_KEY;
        if (!raw) {
            throw new Error('SapAiCoreEmbedder (foundation-models): no credentials provided and AICORE_SERVICE_KEY env var is not set');
        }
        return parseServiceKey(raw);
    }
}
function detectFamily(model) {
    return /^gemini/i.test(model) ? 'gemini' : 'azure-openai';
}
//# sourceMappingURL=foundation-embedder.js.map