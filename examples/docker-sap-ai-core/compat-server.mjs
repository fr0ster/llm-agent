import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || "8080");
const LLM_AGENT_URL =
	process.env.LLM_AGENT_URL || "http://llm-agent-core:8010/v1/chat/completions";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic--claude-4.6-sonnet";

// MCP_ENABLED: 'true' = required, 'optional' = best-effort, 'false' = disabled
const MCP_MODE = (process.env.MCP_ENABLED || "true").toLowerCase();
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "";

const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || "32768");
const LLM_CLASSIFIER_MODEL = process.env.LLM_CLASSIFIER_MODEL || "gpt-4.1-mini";
const RAG_EMBEDDER = process.env.RAG_EMBEDDER || "sap-aicore";
const CORE_BASE = "http://llm-agent-core:8010";

const CREATE_FILE_TOOL = {
	type: "function",
	function: {
		name: "create_file",
		description:
			"Save content as a downloadable file for the user.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Filename with extension (e.g. report.md, diagram.mmd). No directories — just the filename.",
				},
				content: {
					type: "string",
					description:
						"Complete file content, fully formatted and ready to save.",
				},
			},
			required: ["path", "content"],
		},
	},
};

// ---------------------------------------------------------------------------
// Validated models cache — probes each model from catalog, caches working ones.
// Models that fail during real usage are immediately evicted and re-probed
// on the next refresh cycle.
// ---------------------------------------------------------------------------
const modelsCache = { data: null, expiry: 0 };
const MODELS_CACHE_TTL_MS = 300_000; // 5 min
// Background refresh interval (ms). 0 = disabled (probe only at startup).
const MODELS_REFRESH_INTERVAL_MS = Number(
	process.env.MODELS_REFRESH_INTERVAL_MS || "0",
);
const SKIP_PATTERN = /embed|rerank/i;

// Set of model IDs that failed during real usage (evicted until next probe cycle)
const failedModels = new Set();
// Models permanently evicted — don't support tool-use or not deployed (400/404).
// Never re-probed unless server restarts.
const permanentlyFailed = new Set();

// Probe payload includes a dummy tool — models that don't support tool_use will fail
// here rather than on a real user request.
const PROBE_TOOL = {
	type: "function",
	function: {
		name: "probe_echo",
		description: "Echo the input back (probe-only, never actually called)",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
};

/**
 * Probe a model with a tool-use request.
 * Returns: "ok" | "transient" (503 — cold start, retry later) | "permanent" (400/404 — evict forever)
 */
async function probeModel(model) {
	try {
		const resp = await fetch(`${CORE_BASE}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer sk-none",
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: 'Reply with the word "ok".' }],
				tools: [PROBE_TOOL],
				max_tokens: 4,
			}),
			signal: AbortSignal.timeout(20000),
		});
		if (!resp.ok) {
			// 503 = AI Core cold start — transient, will retry next cycle
			if (resp.status === 503) return "transient";
			// 400/404 = model not deployed or doesn't accept tool-use
			if (resp.status === 400 || resp.status === 404) return "permanent";
			return "transient";
		}
		const data = await resp.json();
		const content = data?.choices?.[0]?.message?.content || "";
		if (content.startsWith("Error:")) {
			// Core agent wraps upstream errors — check for permanent failures
			if (/status\s*code\s*(400|404)/i.test(content)) return "permanent";
			if (/status\s*code\s*503/i.test(content)) return "transient";
			return "permanent";
		}
		return "ok";
	} catch {
		return "transient";
	}
}

/**
 * Mark a model as permanently failed — immediately removes it from cached model list
 * and adds to permanentlyFailed so it's never re-probed.
 */
function invalidateModel(modelId) {
	if (!modelId || permanentlyFailed.has(modelId)) return;
	permanentlyFailed.add(modelId);
	failedModels.delete(modelId); // no need to track in transient set anymore
	log("model_permanently_failed", { model: modelId });
	if (modelsCache.data) {
		const before = modelsCache.data.data.length;
		modelsCache.data.data = modelsCache.data.data.filter(
			(m) => m.id !== modelId,
		);
		const after = modelsCache.data.data.length;
		if (before !== after) {
			log("model_evicted_from_cache", { model: modelId, remaining: after });
		}
	}
}

let _probeInFlight = null;

async function getValidatedModels() {
	if (modelsCache.data && Date.now() < modelsCache.expiry)
		return modelsCache.data;
	// Non-blocking: if probe already running, return stale/empty cache immediately
	if (_probeInFlight) return modelsCache.data || { object: "list", data: [] };
	_probeInFlight = refreshModelsCache().finally(() => {
		_probeInFlight = null;
	});
	return _probeInFlight;
}

async function refreshModelsCache() {
	try {
		const resp = await fetch(`${CORE_BASE}/v1/models`, {
			signal: AbortSignal.timeout(5000),
		});
		const catalog = await resp.json();
		// Pass through core's model list — core resolves models from SAP AI Core SDK.
		// Skip only embedding/reranker models.
		const models = (catalog.data || []).filter(
			(m) => !SKIP_PATTERN.test(m.id),
		);
		log("models_loaded", { count: models.length });
		const data = { object: "list", data: models };
		modelsCache.data = data;
		modelsCache.expiry = Date.now() + MODELS_CACHE_TTL_MS;
		return data;
	} catch {
		return (
			modelsCache.data || {
				object: "list",
				data: [{ id: LLM_MODEL, object: "model", owned_by: "llm-agent" }],
			}
		);
	}
}

// Background periodic refresh — keeps model list up-to-date without waiting for client requests.
// Disabled by default (MODELS_REFRESH_INTERVAL_MS=0); set to e.g. 300000 for 5-min cycles.
if (MODELS_REFRESH_INTERVAL_MS > 0) {
	setInterval(() => {
		refreshModelsCache().catch((e) =>
			log("models_bg_refresh_error", { error: e.message }),
		);
	}, MODELS_REFRESH_INTERVAL_MS);
	log("models_bg_refresh_enabled", { intervalMs: MODELS_REFRESH_INTERVAL_MS });
}

const HTML = readFileSync(
	new URL("./index.html", import.meta.url),
	"utf8",
).replace("{{GIT_BRANCH}}", process.env.GIT_BRANCH || "unknown");

// ---------------------------------------------------------------------------
// MCP reachability probe — lightweight GET /mcp/health
// ---------------------------------------------------------------------------

async function probeMcpHealth() {
	if (MCP_MODE === "false" || !MCP_SERVER_URL) return undefined;
	try {
		const mcpHealthUrl = MCP_SERVER_URL.replace(
			/\/stream\/http\/?$/,
			"/health",
		);
		const probe = await fetch(mcpHealthUrl, {
			signal: AbortSignal.timeout(3000),
		});
		return probe.ok;
	} catch {
		return false;
	}
}

function log(event, data = {}) {
	console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

function jsonResponse(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Per-request trace & global stats collector
// ---------------------------------------------------------------------------

function createTrace() {
	const id = crypto.randomUUID();
	const t0 = Date.now();
	const stages = [];
	return {
		id,
		t0,
		start(name, type) {
			const startMs = Date.now() - t0;
			const stage = { name, type, startMs, endMs: 0, tokens: null };
			stages.push(stage);
			return {
				finish(tokens) {
					stage.endMs = Date.now() - t0;
					if (tokens) stage.tokens = tokens;
				},
			};
		},
		toSteps() {
			return stages.map((s) => ({
				type: s.type,
				tool: s.name,
				args: {
					...(s.tokens && { ...s.tokens }),
					duration_ms: s.endMs - s.startMs,
				},
			}));
		},
		toRecord() {
			return {
				requestId: id,
				timestamp: new Date(t0).toISOString(),
				stages: [...stages],
				totalDurationMs: Date.now() - t0,
			};
		},
	};
}

const statsCollector = {
	_buffer: [],
	_max: 100,
	push(record) {
		this._buffer.push(record);
		if (this._buffer.length > this._max) this._buffer.shift();
	},
	getAll() {
		return this._buffer;
	},
	getSummary() {
		const buf = this._buffer;
		if (!buf.length)
			return { totalRequests: 0, avgTotalDurationMs: 0, stages: {} };
		const stageMap = {};
		let totalDur = 0;
		for (const rec of buf) {
			totalDur += rec.totalDurationMs;
			for (const s of rec.stages) {
				if (!stageMap[s.name])
					stageMap[s.name] = {
						count: 0,
						totalMs: 0,
						totalPrompt: 0,
						totalCompletion: 0,
					};
				const m = stageMap[s.name];
				m.count++;
				m.totalMs += s.endMs - s.startMs;
				if (s.tokens) {
					m.totalPrompt += s.tokens.prompt_tokens || 0;
					m.totalCompletion += s.tokens.completion_tokens || 0;
				}
			}
		}
		const stages = {};
		for (const [name, m] of Object.entries(stageMap)) {
			stages[name] = { count: m.count, avgMs: Math.round(m.totalMs / m.count) };
			if (m.totalPrompt || m.totalCompletion) {
				stages[name].totalTokens = {
					prompt: m.totalPrompt,
					completion: m.totalCompletion,
				};
			}
		}
		return {
			totalRequests: buf.length,
			avgTotalDurationMs: Math.round(totalDur / buf.length),
			stages,
		};
	},
};

// ---------------------------------------------------------------------------
// Chat history RAG — embeds each exchange into Qdrant `chat_history` collection.
// Core agent queries it automatically (ragRetrievalMode: always) and injects
// only semantically relevant past exchanges into context.
// ---------------------------------------------------------------------------
const QDRANT_URL = process.env.QDRANT_URL || "http://host.docker.internal:6333";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding";
const CHAT_HISTORY_COLLECTION = "chat_history";
const VECTOR_SIZE = 3072;

// AI Core OAuth2 for embeddings
const AICORE_BASE_URL = process.env.AICORE_BASE_URL || "";
const AICORE_AUTH_URL = process.env.AICORE_AUTH_URL || "";
const AICORE_CLIENT_ID = process.env.AICORE_CLIENT_ID || "";
const AICORE_CLIENT_SECRET = process.env.AICORE_CLIENT_SECRET || "";

let _aicoreToken = null;
let _aicoreTokenExpiry = 0;
let _embeddingDeploymentId = null;

async function getAiCoreToken() {
	if (_aicoreToken && Date.now() < _aicoreTokenExpiry - 60000)
		return _aicoreToken;
	const resp = await fetch(`${AICORE_AUTH_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `grant_type=client_credentials&client_id=${encodeURIComponent(AICORE_CLIENT_ID)}&client_secret=${encodeURIComponent(AICORE_CLIENT_SECRET)}`,
	});
	if (!resp.ok) throw new Error(`AI Core token error: ${resp.status}`);
	const data = await resp.json();
	_aicoreToken = data.access_token;
	_aicoreTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
	return _aicoreToken;
}

async function getEmbeddingDeploymentId() {
	if (_embeddingDeploymentId) return _embeddingDeploymentId;
	const token = await getAiCoreToken();
	const resp = await fetch(
		`${AICORE_BASE_URL}/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				"AI-Resource-Group": "default",
			},
		},
	);
	if (!resp.ok) throw new Error(`AI Core deployments query failed: ${resp.status}`);
	const data = await resp.json();
	const dep = data.resources?.find(
		(r) => r.details?.resources?.backend_details?.model?.name === EMBEDDING_MODEL,
	);
	if (!dep?.id)
		throw new Error(`No running deployment for ${EMBEDDING_MODEL}`);
	_embeddingDeploymentId = dep.id;
	return dep.id;
}

async function embedText(text) {
	const token = await getAiCoreToken();
	const deploymentId = await getEmbeddingDeploymentId();
	const resp = await fetch(
		`${AICORE_BASE_URL}/v2/inference/deployments/${deploymentId}/models/${EMBEDDING_MODEL}:predict`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"AI-Resource-Group": "default",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ instances: [{ content: text }] }),
			signal: AbortSignal.timeout(15000),
		},
	);
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Embedding error ${resp.status}: ${err.slice(0, 200)}`);
	}
	const data = await resp.json();
	return data.predictions[0].embeddings.values;
}

async function ensureChatHistoryCollection() {
	try {
		const resp = await fetch(`${QDRANT_URL}/collections/${CHAT_HISTORY_COLLECTION}`);
		if (resp.ok) return;
	} catch {}
	// Create collection
	await fetch(`${QDRANT_URL}/collections/${CHAT_HISTORY_COLLECTION}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			vectors: { size: VECTOR_SIZE, distance: "Cosine" },
		}),
	});
	log("chat_history_collection_created");
}

// Deterministic UUID from text (SHA-256 based)
async function deterministicId(text) {
	const data = new TextEncoder().encode(text);
	const buf = await crypto.subtle.digest("SHA-256", data);
	const hex = [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return (
		hex.slice(0, 8) +
		"-" +
		hex.slice(8, 12) +
		"-" +
		hex.slice(12, 16) +
		"-" +
		hex.slice(16, 20) +
		"-" +
		hex.slice(20, 32)
	);
}

// In-memory last exchange — always available for short follow-up queries
// (RAG semantic search may miss anaphoric references like "this", "that", "це")
let _lastExchange = null;

/**
 * Search chat_history for exchanges semantically similar to the query.
 * Returns context string to prepend to the user message, or "".
 */
async function searchChatHistory(query, k = 3) {
	try {
		const resp = await fetch(
			`${QDRANT_URL}/collections/${CHAT_HISTORY_COLLECTION}`,
			{ signal: AbortSignal.timeout(2000) },
		);
		if (!resp.ok) return "";
		const info = await resp.json();
		if ((info.result?.points_count || 0) === 0) return "";

		const vector = await embedText(query);
		const searchResp = await fetch(
			`${QDRANT_URL}/collections/${CHAT_HISTORY_COLLECTION}/points/search`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					vector,
					limit: k,
					score_threshold: 0.35,
					with_payload: true,
				}),
			},
		);
		if (!searchResp.ok) return "";
		const data = await searchResp.json();
		const results = data.result || [];
		if (results.length === 0) return "";
		const context = results
			.map((r) => r.payload.text)
			.join("\n---\n");
		log("chat_history_found", {
			query: query.slice(0, 80),
			matches: results.length,
			topScore: results[0]?.score,
		});
		return context;
	} catch (e) {
		log("chat_history_search_error", { error: e.message });
		return "";
	}
}

/**
 * Build messages array with chat history context injected into the user message.
 * Core agent strips extra system messages during context assembly, so we embed
 * history directly in the user text where the classifier and LLM both see it.
 * Combines two sources:
 * 1. In-memory last exchange (always present — handles "this/that/це" follow-ups)
 * 2. Semantic RAG search (finds older relevant exchanges)
 */
async function buildMessagesWithHistory(userMessage, { includeLastExchange = true } = {}) {
	const historyContext = await searchChatHistory(userMessage);
	const parts = [];
	// Include last exchange for immediate follow-ups (UI /chat only —
	// OpenAI clients manage their own conversation history)
	if (includeLastExchange && _lastExchange) {
		parts.push(_lastExchange.userMessage);
	}
	// Add semantic matches (deduplicate against last exchange)
	if (historyContext) {
		// Extract only user messages from history to avoid polluting ragText
		// with assistant responses (which can mislead classifier and RAG)
		const ragParts = historyContext
			.split("\n---\n")
			.map((p) => {
				const userMatch = p.match(/^User:\s*(.*?)(?:\nAssistant:)/s);
				return userMatch ? userMatch[1].trim() : "";
			})
			.filter((p) => p && (!_lastExchange || p !== _lastExchange.userMessage));
		parts.push(...ragParts);
	}
	let enrichedMessage = userMessage;
	if (parts.length > 0) {
		enrichedMessage = `[Previous questions for context: ${parts.join(" | ")}]\n\n${userMessage}`;
	}
	return [{ role: "user", content: enrichedMessage }];
}

/**
 * Save a chat exchange to Qdrant for semantic retrieval.
 * Runs in background — errors are logged but don't block the response.
 */
async function saveChatExchange(userMessage, assistantReply) {
	// Update in-memory last exchange immediately (before async Qdrant ops)
	const text = `User: ${userMessage}\nAssistant: ${assistantReply.slice(0, 2000)}`;
	_lastExchange = { text, userMessage, assistantReply: assistantReply.slice(0, 4000) };
	try {
		await ensureChatHistoryCollection();
		const vector = await embedText(text);
		const pointId = await deterministicId(text);
		await fetch(`${QDRANT_URL}/collections/${CHAT_HISTORY_COLLECTION}/points`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				points: [
					{
						id: pointId,
						vector,
						payload: {
							text,
							content: text,
							user_message: userMessage,
							assistant_reply: assistantReply.slice(0, 4000),
							timestamp: new Date().toISOString(),
						},
					},
				],
			}),
		});
		log("chat_history_saved", { pointId, textLen: text.length });
	} catch (e) {
		log("chat_history_save_error", { error: e.message });
	}
}

// ---------------------------------------------------------------------------
// Core agent call (smart pipeline with MCP tools + RAG + memory)
// ---------------------------------------------------------------------------

async function callCoreAgent(
	messages,
	temperature = 0.2,
	retries = 8,
	model = LLM_MODEL,
	tools = null,
) {
	// Each request gets a unique session — agent builds context from RAG, not chat history.
	// Important facts from conversation are persisted via rag-upsert stage (facts/state/feedback).
	const sessionId = crypto.randomUUID();
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const resp = await fetch(LLM_AGENT_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": sessionId,
					Authorization: "Bearer sk-none",
				},
				body: JSON.stringify({
					model,
					messages,
					temperature,
					max_tokens: LLM_MAX_TOKENS,
					...(tools?.length && { tools }),
				}),
			});

			if (!resp.ok) {
				const errText = await resp.text();
				log("llm_error", {
					status: resp.status,
					body: errText.slice(0, 300),
					model,
				});
				// 400 from upstream LLM provider = model not available/deployed
				if (resp.status === 400 || resp.status === 404) invalidateModel(model);
				throw new Error(`llm-agent error ${resp.status}: ${errText}`);
			}

			const data = await resp.json();
			const usage = data?.usage || {};
			log("llm_raw_usage", { usage });

			// Core agent wraps LLM errors as 200 with "Error:" content — detect and invalidate
			const content = data?.choices?.[0]?.message?.content || "";
			if (
				content.startsWith("Error:") &&
				/status\s*code\s*(400|404)/i.test(content)
			) {
				invalidateModel(model);
			}

			return data;
		} catch (e) {
			const isNetworkError =
				e.cause?.code === "ECONNREFUSED" || e.message === "fetch failed";
			if (isNetworkError && attempt < retries) {
				const delay = 5000;
				log("llm_retry", {
					attempt: attempt + 1,
					maxRetries: retries,
					delayMs: delay,
					error: e.message,
				});
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}
			throw e;
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 1_000_000) {
				reject(new Error("Payload too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	// Normalize URL: strip duplicate /v1 prefix (clients set base_url=/v1 → request /v1/chat/completions → /v1/v1/...)
	req.url = req.url.replace(/^\/v1\/v1\//, "/v1/");
	log("http_request", { method: req.method, url: req.url });
	try {
		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(HTML);
			return;
		}

		if (req.method === "GET" && req.url === "/health") {
			// Lightweight health: check core agent is reachable + MCP probe.
			// Core agent now handles RAG health internally (v3.0.0).
			// v5.18.2: core healthTimeoutMs is configurable — set to 15s in smart-server.yaml
			try {
				const [coreHealth, mcpReachable] = await Promise.all([
					fetch("http://llm-agent-core:8010/v1/health", {
						signal: AbortSignal.timeout(20000),
					})
						.then((r) => r.ok ? r.json() : null)
						.catch(() => null),
					probeMcpHealth(),
				]);
				const coreAlive = !!coreHealth;
				const resp = {
					status: coreAlive ? "ok" : "starting",
					components: { llm: coreAlive },
					mcpMode: MCP_MODE,
				};
				if (coreHealth?.version) resp.coreVersion = coreHealth.version;
				if (mcpReachable !== undefined) resp.mcpReachable = mcpReachable;
				jsonResponse(res, 200, resp);
			} catch {
				jsonResponse(res, 200, {
					status: "starting",
					message: "Core agent not reachable yet",
					mcpMode: MCP_MODE,
				});
			}
			return;
		}

		if (req.method === "GET" && req.url === "/stats") {
			jsonResponse(res, 200, {
				requests: statsCollector.getAll(),
				summary: statsCollector.getSummary(),
			});
			return;
		}

		// -----------------------------------------------------------------------
		// OpenAI-compatible /v1/chat/completions — proxy for Cline, Goose, etc.
		// Core agent streaming is broken (pipeline skips stages with stream:true),
		// so we always call core non-streaming and return the result.
		// All MCP tool calls are handled internally — never exposed to the client.
		// -----------------------------------------------------------------------
		if (
			req.method === "GET" &&
			(req.url === "/v1/models" || req.url === "/models")
		) {
			const data = await getValidatedModels();
			jsonResponse(res, 200, data);
			return;
		}

		// Proxy GET/PUT /v1/config to core (v5.19.0)
		if (req.url === "/v1/config" || req.url === "/config") {
			try {
				const opts = { method: req.method, signal: AbortSignal.timeout(5000) };
				if (req.method === "PUT") {
					opts.headers = { "Content-Type": "application/json" };
					opts.body = await readBody(req);
				}
				const coreResp = await fetch(`${CORE_BASE}/v1/config`, opts);
				const data = await coreResp.json();
				// Enrich with compat-level info not available in core
				if (req.method === "GET" && data.models) {
					data.embedding = { model: EMBEDDING_MODEL, embedder: RAG_EMBEDDER, rag_type: "qdrant" };
				}
				jsonResponse(res, coreResp.status, data);
			} catch (e) {
				jsonResponse(res, 502, { error: `Core config unreachable: ${e.message}` });
			}
			return;
		}

		if (
			req.method === "GET" &&
			(req.url === "/v1/health" || req.url === "/health")
		) {
			// already handled above for /health, so this catches /v1/health
			try {
				const coreAlive = await fetch("http://llm-agent-core:8010/v1/health", {
					signal: AbortSignal.timeout(20000),
				})
					.then((r) => r.ok)
					.catch(() => false);
				jsonResponse(res, 200, { status: coreAlive ? "ok" : "starting" });
			} catch {
				jsonResponse(res, 200, { status: "starting" });
			}
			return;
		}

		if (
			req.method === "POST" &&
			(req.url === "/v1/chat/completions" || req.url === "/chat/completions")
		) {
			const bodyText = await readBody(req);
			const body = JSON.parse(bodyText || "{}");
			const rawMessages = body.messages || [];
			const wantStream = body.stream === true;

			if (!rawMessages.length) {
				jsonResponse(res, 400, {
					error: {
						message: "messages array is required",
						type: "invalid_request_error",
					},
				});
				return;
			}

			// OpenAI clients (Cline, Goose) manage their own conversation history.
			// Pass messages as-is — no RAG enrichment (client context is authoritative).
			const messages = rawMessages;

			const trace = createTrace();
			log("openai_start", {
				requestId: trace.id,
				stream: wantStream,
				messagesCount: messages.length,
				toolsCount: (body.tools || []).length,
				toolNames: (body.tools || []).map((t) => t.function?.name).filter(Boolean).slice(0, 10),
			});

			const clientTools = body.tools || null;

			if (wantStream) {
				// Stream mode: proxy SSE chunks from core directly to client.
				// Core (v4.0.7) handles streaming correctly for all cases:
				// - Simple requests: streams content tokens
				// - With external tools: streams tool_calls + finish_reason:"tool_calls" + [DONE]
				const sessionId = crypto.randomUUID();
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				});
				const heartbeat = setInterval(() => {
					res.write(": heartbeat\n\n");
				}, 5000);
				try {
					const coreResp = await fetch(LLM_AGENT_URL, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Session-Id": sessionId,
							Authorization: "Bearer sk-none",
						},
						body: JSON.stringify({
							model: body.model || LLM_MODEL,
							messages,
							temperature: body.temperature ?? 0.2,
							max_tokens: LLM_MAX_TOKENS,
							stream: true,
							...(clientTools?.length && { tools: clientTools }),
						}),
					});
					clearInterval(heartbeat);

					if (!coreResp.ok) {
						const errText = await coreResp.text();
						log("openai_error", {
							requestId: trace.id,
							error: `core ${coreResp.status}: ${errText.slice(0, 200)}`,
						});
						res.write(
							`data: ${JSON.stringify({
								id: `chatcmpl-${trace.id}`,
								object: "chat.completion.chunk",
								created: Math.floor(Date.now() / 1000),
								model: body.model || LLM_MODEL,
								choices: [{ index: 0, delta: { role: "assistant", content: `Error: ${errText.slice(0, 200)}` }, finish_reason: "stop" }],
							})}\n\n`,
						);
						res.write("data: [DONE]\n\n");
					} else {
						const stage = trace.start("core_agent", "LLM");
						for await (const chunk of coreResp.body) {
							res.write(chunk);
						}
						stage.finish({});
						log("openai_done", {
							requestId: trace.id,
							durationMs: Date.now() - trace.t0,
							stream: true,
						});
						statsCollector.push(trace.toRecord());
					}
				} catch (e) {
					clearInterval(heartbeat);
					log("openai_error", { requestId: trace.id, error: e.message });
					if (!res.writableEnded) {
						res.write(
							`data: ${JSON.stringify({
								id: `chatcmpl-${trace.id}`,
								object: "chat.completion.chunk",
								created: Math.floor(Date.now() / 1000),
								model: body.model || LLM_MODEL,
								choices: [{ index: 0, delta: { role: "assistant", content: `Error: ${e.message}` }, finish_reason: "stop" }],
							})}\n\n`,
						);
						res.write("data: [DONE]\n\n");
					}
				} finally {
					clearInterval(heartbeat);
					if (!res.writableEnded) res.end();
				}
			} else {
				// Non-stream mode: single JSON response
				try {
					const stage = trace.start("core_agent", "LLM");
					const llm = await callCoreAgent(
						messages,
						body.temperature ?? 0.2,
						8,
						body.model || LLM_MODEL,
						clientTools,
					);
					const usage = llm?.usage || {
						prompt_tokens: 0,
						completion_tokens: 0,
						total_tokens: 0,
					};
					stage.finish({
						prompt_tokens: usage.prompt_tokens || 0,
						completion_tokens: usage.completion_tokens || 0,
					});

					const coreMsg2 = llm?.choices?.[0]?.message || {};
					const coreToolCalls2 = coreMsg2.tool_calls || [];

					const totalMs = Date.now() - trace.t0;
					log("openai_done", {
						requestId: trace.id,
						durationMs: totalMs,
						tokens:
							usage.total_tokens ||
							usage.prompt_tokens + usage.completion_tokens,
					});
					statsCollector.push(trace.toRecord());

					if (coreToolCalls2.length > 0) {
						// Pass through tool_calls to client
						jsonResponse(res, 200, {
							id: `chatcmpl-${trace.id}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: body.model || LLM_MODEL,
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: coreMsg2.content || null,
										tool_calls: coreToolCalls2,
									},
									finish_reason: "tool_calls",
								},
							],
							usage,
						});
					} else {
						let content = coreMsg2.content || "";
						content = content
							.replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/g, "")
							.trim();
						if (!content)
							content =
								"I have processed your request. How can I help you further?";

						// No chat history save for OpenAI clients — they manage own context

						jsonResponse(res, 200, {
							id: `chatcmpl-${trace.id}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: body.model || LLM_MODEL,
							choices: [
								{
									index: 0,
									message: { role: "assistant", content },
									finish_reason: "stop",
								},
							],
							usage,
						});
					}
				} catch (e) {
					log("openai_error", { requestId: trace.id, error: e.message });
					jsonResponse(res, 500, {
						error: { message: e.message, type: "server_error" },
					});
				}
			}
			return;
		}

		if (req.method === "POST" && req.url === "/chat/clear") {
			// Drop and recreate chat_history collection + clear in-memory buffer
			_lastExchange = null;
			try {
				await fetch(
					`${QDRANT_URL}/collections/${CHAT_HISTORY_COLLECTION}`,
					{ method: "DELETE" },
				);
				await ensureChatHistoryCollection();
			} catch {}
			log("chat_history_cleared");
			jsonResponse(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && req.url === "/chat") {
			const bodyText = await readBody(req);
			const body = JSON.parse(bodyText || "{}");
			const message = String(body.message || "").trim();

			if (!message) {
				jsonResponse(res, 400, {
					response: 'Field "message" is required',
					steps: [],
					usage: { prompt_tokens: 0, completion_tokens: 0 },
				});
				return;
			}

			// SSE mode: stream heartbeats while core agent works
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});

			const trace = createTrace();
			log("chat_start", {
				requestId: trace.id,
				message: message.slice(0, 120),
			});

			// Heartbeat every 3s so UI knows we're alive
			let heartbeatCount = 0;
			const heartbeat = setInterval(() => {
				heartbeatCount++;
				const elapsed = ((Date.now() - trace.t0) / 1000).toFixed(0);
				res.write(
					`event: heartbeat\ndata: ${JSON.stringify({ elapsed: Number(elapsed), tick: heartbeatCount })}\n\n`,
				);
			}, 3000);

			try {
				// Search chat_history RAG for relevant past exchanges, then call core agent.
				res.write(
					`event: phase\ndata: ${JSON.stringify({ phase: "core_agent" })}\n\n`,
				);
				const stage = trace.start("core_agent", "LLM");
				const messagesWithHistory = await buildMessagesWithHistory(message);
				const llm = await callCoreAgent(
					messagesWithHistory,
					0.2,
					8,
					body.model || LLM_MODEL,
					[CREATE_FILE_TOOL],
				);
				const usage = llm?.usage || { prompt_tokens: 0, completion_tokens: 0 };
				stage.finish({
					prompt_tokens: usage.prompt_tokens || 0,
					completion_tokens: usage.completion_tokens || 0,
				});

				const msg = llm?.choices?.[0]?.message || {};
				const toolCalls = msg.tool_calls || [];
				const files = [];
				let reply = msg.content || "";

				// --- Tool calls loop: handle create_file ---
				if (toolCalls.length > 0) {
					const createFileCalls = toolCalls.filter(
						(tc) => tc.function?.name === "create_file",
					);
					for (const tc of createFileCalls) {
						try {
							const args = JSON.parse(tc.function.arguments);
							files.push({ path: args.path, content: args.content });
						} catch {
							files.push({ path: "unknown", content: tc.function.arguments });
						}
					}

					if (files.length > 0) {
						// Notify UI about generated files
						res.write(
							`event: phase\ndata: ${JSON.stringify({
								phase: "file_created",
								files: files.map((f) => f.path),
							})}\n\n`,
						);

						// Build messages for second round-trip:
						// original messages + assistant message with tool_calls + tool results
						const toolResultMessages = toolCalls.map((tc) => {
							if (tc.function?.name === "create_file") {
								const file = files[createFileCalls.indexOf(tc)];
								return {
									role: "tool",
									tool_call_id: tc.id,
									content: `File created: ${file?.path || "file"}`,
								};
							}
							return { role: "tool", tool_call_id: tc.id, content: "OK" };
						});
						const secondMessages = [
							...messagesWithHistory,
							{ role: "assistant", tool_calls: toolCalls },
							...toolResultMessages,
						];

						const stage2 = trace.start("file_summary", "LLM");
						try {
							const llm2 = await callCoreAgent(
								secondMessages,
								0.2,
								8,
								body.model || LLM_MODEL,
							);
							const usage2 = llm2?.usage || {
								prompt_tokens: 0,
								completion_tokens: 0,
							};
							stage2.finish({
								prompt_tokens: usage2.prompt_tokens || 0,
								completion_tokens: usage2.completion_tokens || 0,
							});
							reply = llm2?.choices?.[0]?.message?.content || "";
							// Merge usage from both calls
							usage.prompt_tokens =
								(usage.prompt_tokens || 0) + (usage2.prompt_tokens || 0);
							usage.completion_tokens =
								(usage.completion_tokens || 0) + (usage2.completion_tokens || 0);
						} catch (e2) {
							stage2.finish({});
							log("file_summary_error", { error: e2.message });
							reply = `Files generated successfully. Summary unavailable: ${e2.message}`;
						}
					}
				}

				// Save exchange with final text response (not intermediate tool_calls)
				saveChatExchange(message, reply);
				const totalMs = Date.now() - trace.t0;
				log("chat_done", {
					requestId: trace.id,
					durationMs: totalMs,
					prompt_tokens: usage.prompt_tokens,
					completion_tokens: usage.completion_tokens,
				});

				statsCollector.push(trace.toRecord());

				res.write(
					`event: result\ndata: ${JSON.stringify({
						response: reply,
						files,
						steps: trace.toSteps(),
						usage: { ...usage, total_duration_ms: totalMs },
					})}\n\n`,
				);
			} catch (e) {
				res.write(
					`event: result\ndata: ${JSON.stringify({
						response: `System Error: ${e.message}`,
						steps: trace.toSteps(),
						usage: {
							prompt_tokens: 0,
							completion_tokens: 0,
							total_duration_ms: Date.now() - trace.t0,
						},
					})}\n\n`,
				);
			} finally {
				clearInterval(heartbeat);
				res.end();
			}
			return;
		}

		jsonResponse(res, 404, { error: "Not found" });
	} catch (e) {
		jsonResponse(res, 500, {
			response: `System Error: ${e.message}`,
			steps: [],
			usage: { prompt_tokens: 0, completion_tokens: 0 },
		});
	}
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`llm-agent-compat listening on http://0.0.0.0:${PORT}`);
});
