/**
 * SAP AI Core Embedder plugin for @mcp-abap-adt/llm-agent.
 *
 * Registers 'sap-aicore' embedder factory — uses gemini-embedding
 * via SAP AI Core Vertex AI predict endpoint.
 *
 * Usage in smart-server.yaml:
 *   rag:
 *     type: qdrant
 *     embedder: sap-aicore
 *     model: gemini-embedding
 *
 * Auth: AICORE_* env vars (OAuth2 client credentials).
 */

const AICORE_BASE_URL = process.env.AICORE_BASE_URL || '';
const AICORE_AUTH_URL = process.env.AICORE_AUTH_URL || '';
const AICORE_CLIENT_ID = process.env.AICORE_CLIENT_ID || '';
const AICORE_CLIENT_SECRET = process.env.AICORE_CLIENT_SECRET || '';

// Throttle between embedding calls (ms) — prevents SAP AI Core rate limiting
// during tool vectorization (139 calls at startup). Set 0 for local embedders.
const EMBED_THROTTLE_MS = Number(process.env.EMBED_THROTTLE_MS || '350');
let lastEmbedTime = 0;

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedDeploymentId = null;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const resp = await fetch(`${AICORE_AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(AICORE_CLIENT_ID)}&client_secret=${encodeURIComponent(AICORE_CLIENT_SECRET)}`
  });
  if (!resp.ok) throw new Error(`AI Core token error: ${resp.status}`);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function resolveDeploymentId(model) {
  if (cachedDeploymentId) return cachedDeploymentId;
  const token = await getToken();
  const resp = await fetch(
    `${AICORE_BASE_URL}/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING`,
    { headers: { 'Authorization': `Bearer ${token}`, 'AI-Resource-Group': 'default' } }
  );
  if (!resp.ok) throw new Error(`AI Core deployments query failed: ${resp.status}`);
  const data = await resp.json();
  const deployment = data.resources?.find(
    r => r.details?.resources?.backend_details?.model?.name === model
  );
  const id = deployment?.id;
  if (!id) throw new Error(`No running deployment found for model ${model}`);
  cachedDeploymentId = id;
  return id;
}

class SapAiCoreEmbedder {
  constructor(config) {
    this.model = config.model || 'gemini-embedding';
    this.timeoutMs = config.timeoutMs || 30000;
  }

  async embed(text, _options) {
    const maxRetries = Number(process.env.EMBED_MAX_RETRIES || '5');
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Throttle to avoid SAP AI Core rate limiting during bulk vectorization
      if (EMBED_THROTTLE_MS > 0) {
        const elapsed = Date.now() - lastEmbedTime;
        if (elapsed < EMBED_THROTTLE_MS) {
          await new Promise(r => setTimeout(r, EMBED_THROTTLE_MS - elapsed));
        }
      }
      lastEmbedTime = Date.now();
      const token = await getToken();
      const deploymentId = await resolveDeploymentId(this.model);
      const resp = await fetch(
        `${AICORE_BASE_URL}/v2/inference/deployments/${deploymentId}/models/${this.model}:predict`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'AI-Resource-Group': 'default',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ instances: [{ content: text }] }),
          signal: AbortSignal.timeout(this.timeoutMs)
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        return data.predictions[0].embeddings.values;
      }
      // Retry on rate limit (429) or server errors (5xx)
      if (attempt < maxRetries && (resp.status === 429 || resp.status >= 500)) {
        // Respect Retry-After header if present, otherwise exponential backoff
        const retryAfter = resp.headers.get('retry-after');
        const backoff = retryAfter
          ? Number(retryAfter) * 1000
          : Math.min(1000 * Math.pow(2, attempt + 1), 30000);
        lastEmbedTime = Date.now() + backoff; // prevent next call from firing immediately
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      const errText = await resp.text();
      throw new Error(`AI Core embedding error ${resp.status}: ${errText.slice(0, 200)}`);
    }
  }
}

/** @type {Record<string, import('@mcp-abap-adt/llm-agent').EmbedderFactory>} */
export const embedderFactories = {
  'sap-aicore': (cfg) => new SapAiCoreEmbedder({
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
  }),
};
