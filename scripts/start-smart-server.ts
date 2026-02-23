/**
 * Smart Server Demo — Ollama Embeddings + DeepSeek + MCP
 *
 * Starts an OpenAI-compatible HTTP server on PORT (default: 3000).
 * ALL output goes to LOG_FILE — nothing is written to stdout/stderr so
 * stdio-based MCP transports work without interference.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat
 *   GET  /v1/usage             — accumulated token usage
 */

import { configDotenv } from 'dotenv';
configDotenv({ path: '.env.smart-server' });
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { DeepSeekProvider } from '../src/llm-providers/deepseek.js';
import { DeepSeekAgent } from '../src/agents/deepseek-agent.js';
import { MCPClientWrapper } from '../src/mcp/client.js';
import { LlmAdapter } from '../src/smart-agent/adapters/llm-adapter.js';
import { McpClientAdapter } from '../src/smart-agent/adapters/mcp-client-adapter.js';
import { OllamaRag } from '../src/smart-agent/rag/ollama-rag.js';
import { TokenCountingLlm } from '../src/smart-agent/llm/token-counting-llm.js';
import { LlmClassifier } from '../src/smart-agent/classifier/llm-classifier.js';
import { ContextAssembler } from '../src/smart-agent/context/context-assembler.js';
import { SmartAgent } from '../src/smart-agent/agent.js';
import type { ILogger } from '../src/smart-agent/logger/index.js';
import type { StopReason } from '../src/smart-agent/agent.js';

// ---------------------------------------------------------------------------
// 1. File logger — ALL output goes here, never stdout/stderr
// ---------------------------------------------------------------------------

const logPath = process.env['LOG_FILE'] ?? 'smart-server.log';
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function log(obj: Record<string, unknown>): void {
  logStream.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

const fileLogger: ILogger = {
  log: (event) => log(event as unknown as Record<string, unknown>),
};

// ---------------------------------------------------------------------------
// 2. Ollama RAG stores (facts / feedback / state)
// ---------------------------------------------------------------------------

const ragOpts = {
  ollamaUrl: process.env['OLLAMA_URL'] ?? 'http://localhost:11434',
  model: process.env['OLLAMA_EMBED_MODEL'] ?? 'nomic-embed-text',
};

const factsRag = new OllamaRag(ragOpts);
const feedbackRag = new OllamaRag(ragOpts);
const stateRag = new OllamaRag(ragOpts);

// ---------------------------------------------------------------------------
// 3. Helper: create a DeepSeek LLM wrapped in TokenCountingLlm
// ---------------------------------------------------------------------------

function makeDeepSeekLlm(temperature = 0.7): TokenCountingLlm {
  const provider = new DeepSeekProvider({
    apiKey: process.env['DEEPSEEK_API_KEY'] ?? '',
    model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
    temperature,
  });

  // DeepSeekAgent requires an mcpClient; pass an embedded no-op client
  const dummyMcp = new MCPClientWrapper({
    transport: 'embedded',
    listToolsHandler: async () => [],
  });

  const agent = new DeepSeekAgent({ llmProvider: provider, mcpClient: dummyMcp });
  const baseLlm = new LlmAdapter(agent);
  return new TokenCountingLlm(baseLlm);
}

const mainLlm = makeDeepSeekLlm(0.7);

// ---------------------------------------------------------------------------
// 4. MCP client (auto-detect: stdio or HTTP)
// ---------------------------------------------------------------------------

let mcpAdapter: McpClientAdapter | null = null;

try {
  if (process.env['MCP_COMMAND']) {
    const rawArgs = process.env['MCP_ARGS'] ?? '';
    const args = rawArgs.length > 0 ? rawArgs.split(' ') : [];
    const mcpWrapper = new MCPClientWrapper({
      transport: 'stdio',
      command: process.env['MCP_COMMAND'],
      args,
    });
    await mcpWrapper.connect();
    mcpAdapter = new McpClientAdapter(mcpWrapper);
    log({ event: 'mcp_connected', transport: 'stdio', command: process.env['MCP_COMMAND'] });
  } else if (process.env['MCP_ENDPOINT']) {
    const mcpWrapper = new MCPClientWrapper({
      transport: 'auto',
      url: process.env['MCP_ENDPOINT'],
    });
    await mcpWrapper.connect();
    mcpAdapter = new McpClientAdapter(mcpWrapper);
    log({ event: 'mcp_connected', transport: 'auto', url: process.env['MCP_ENDPOINT'] });
  } else {
    log({ event: 'mcp_skipped', reason: 'no MCP_COMMAND or MCP_ENDPOINT' });
  }
} catch (mcpErr) {
  log({ event: 'mcp_connect_failed', error: String(mcpErr), continuing: 'without MCP' });
  mcpAdapter = null;
}

// ---------------------------------------------------------------------------
// 5. Vectorize MCP tools → factsRag at startup
// ---------------------------------------------------------------------------

if (mcpAdapter) {
  const toolsResult = await mcpAdapter.listTools();
  if (toolsResult.ok) {
    for (const tool of toolsResult.value) {
      const desc =
        `Tool: ${tool.name}\nDescription: ${tool.description}\nSchema: ${JSON.stringify(tool.inputSchema)}`;
      await factsRag.upsert(desc, { id: `tool:${tool.name}` });
      log({ event: 'tool_vectorized', tool: tool.name });
    }
    log({ event: 'tools_vectorized', count: toolsResult.value.length });
  } else {
    log({ event: 'tools_vectorize_error', error: toolsResult.error.message });
  }
}

// ---------------------------------------------------------------------------
// 6. Classifier + Assembler
// ---------------------------------------------------------------------------

const classifierLlm = makeDeepSeekLlm(0.1);
const classifier = new LlmClassifier(classifierLlm);
const assembler = new ContextAssembler();

// ---------------------------------------------------------------------------
// 7. SmartAgent
// ---------------------------------------------------------------------------

const agent = new SmartAgent(
  {
    mainLlm,
    mcpClients: mcpAdapter ? [mcpAdapter] : [],
    ragStores: { facts: factsRag, feedback: feedbackRag, state: stateRag },
    classifier,
    assembler,
    logger: fileLogger,
  },
  {
    maxIterations: 10,
    maxToolCalls: 30,
    ragQueryK: 5,
  },
);

// ---------------------------------------------------------------------------
// 8. HTTP helpers
// ---------------------------------------------------------------------------

function mapStopReason(r: StopReason): 'stop' | 'length' {
  if (r === 'stop') return 'stop';
  return 'length';
}

function jsonError(message: string, type: string, code?: string): string {
  return JSON.stringify({
    error: { message, type, ...(code !== undefined ? { code } : {}) },
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 9. HTTP server
// ---------------------------------------------------------------------------

const PORT = Number(process.env['PORT'] ?? 3000);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const server = http.createServer(async (req, res) => {
  const urlPath = req.url ?? '/';

  // Set CORS headers on every response
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  // Log every incoming request
  log({ event: 'http_request', method: req.method, url: urlPath, headers: req.headers });

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // GET /v1/models or /models
    if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'smart-agent', object: 'model', owned_by: 'smart-agent' }],
      }));
      return;
    }

    // GET /v1/usage
    if (req.method === 'GET' && urlPath === '/v1/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mainLlm.getUsage()));
      return;
    }

    // POST /v1/chat/completions or /chat/completions
    if (req.method === 'POST' && (urlPath === '/v1/chat/completions' || urlPath === '/chat/completions')) {
      const rawBody = await readBody(req);

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
        return;
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>).messages)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('messages must be a non-empty array', 'invalid_request_error'));
        return;
      }

      type ContentBlock = { type: string; text?: string };
      type MsgContent = string | ContentBlock[];
      const body = parsed as {
        messages: Array<{ role: string; content: MsgContent }>;
        stream?: boolean;
        stream_options?: { include_usage?: boolean };
      };

      // Normalize content: string or [{type:"text",text:"..."}] → string
      const extractText = (c: MsgContent): string => {
        if (typeof c === 'string') return c;
        return c.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('\n');
      };

      if (body.messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('messages must be a non-empty array', 'invalid_request_error'));
        return;
      }

      const userMessages = body.messages.filter((m) => m.role === 'user');
      if (userMessages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(
            'at least one message with role "user" is required',
            'invalid_request_error',
          ),
        );
        return;
      }

      // Detect Cline: its system prompt always starts with "You are Cline"
      const systemMsg = body.messages.find((m) => m.role === 'system');
      const isCline =
        typeof systemMsg?.content === 'string' &&
        systemMsg.content.trimStart().startsWith('You are Cline');

      // Use the FIRST user message as the task — subsequent messages from Cline
      // contain "[ERROR] You did not use a tool..." noise, not the actual request.
      const text = extractText(userMessages[0].content);

      log({ event: 'request_start', mode: isCline ? 'cline' : 'smart', textLength: text.length, stream: body.stream ?? false });
      const t0 = Date.now();

      // -----------------------------------------------------------------------
      // Cline passthrough: forward full message history directly to mainLlm.
      // DeepSeek sees Cline's system prompt and responds with proper XML tool calls.
      // SmartAgent would strip the system prompt and break Cline's protocol.
      // -----------------------------------------------------------------------
      let finalContent: string;
      let finalFinishReason: 'stop' | 'length';

      if (isCline) {
        // Normalize content arrays → strings for every message
        const normalizedMessages = body.messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: extractText(m.content),
        }));

        const llmResult = await mainLlm.chat(normalizedMessages);
        log({ event: 'request_done', mode: 'cline', ok: llmResult.ok, durationMs: Date.now() - t0 });

        if (!llmResult.ok) {
          finalContent = `Error: ${llmResult.error.message}`;
          finalFinishReason = 'stop';
        } else {
          finalContent = llmResult.value.content || '(no response)';
          finalFinishReason = llmResult.value.finishReason === 'length' ? 'length' : 'stop';
        }
      } else {
        // SmartAgent mode: RAG + MCP orchestration
        const result = await agent.process(text);
        log({ event: 'request_done', mode: 'smart', ok: result.ok, durationMs: Date.now() - t0 });

        if (!result.ok) {
          finalContent = `Error: ${result.error.message}`;
          finalFinishReason = 'stop';
        } else {
          finalContent = result.value.content || '(no response)';
          finalFinishReason = mapStopReason(result.value.stopReason);
        }
      }

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const finishReason = finalFinishReason;
      const content = finalContent;

      if (body.stream) {
        // SSE streaming response — matches OpenAI format exactly
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'close',
        });

        const sseChunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: 'smart-agent',
            choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
          })}\n\n`;

        // Chunk 1: role only (OpenAI always sends this first)
        res.write(sseChunk({ role: 'assistant', content: '' }, null));
        // Chunk 2: full content
        res.write(sseChunk({ content }, null));
        // Chunk 3: finish_reason, empty delta
        res.write(sseChunk({}, finishReason));

        // Chunk 4: usage (required when stream_options.include_usage: true)
        if (body.stream_options?.include_usage) {
          const usage = mainLlm.getUsage();
          res.write(`data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', created, model: 'smart-agent',
            choices: [],
            usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
          })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // Regular JSON response
        const response = {
          id,
          object: 'chat.completion',
          created,
          model: 'smart-agent',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: finishReason,
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      }
      return;
    }

    // 404 for all other routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(jsonError(`Cannot ${req.method} ${urlPath}`, 'invalid_request_error'));
  } catch (err) {
    log({ event: 'server_error', error: String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(jsonError(String(err), 'server_error'));
    }
  }
});

server.listen(PORT, () => {
  log({ event: 'server_started', port: PORT, mcp: mcpAdapter ? 'connected' : 'none', logFile: logPath });
  // IMPORTANT: nothing written to process.stdout — only to log file
});
