import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { toToolCallDelta } from '@mcp-abap-adt/llm-agent';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mapStopReason(r) {
    switch (r) {
        case 'stop':
            return 'stop';
        case 'tool_calls':
            return 'tool_calls';
        case 'iteration_limit':
            return 'length';
        case 'tool_call_limit':
            return 'length';
        default: {
            r;
            return 'stop';
        }
    }
}
function jsonError(message, type, code) {
    return JSON.stringify({
        error: { message, type, ...(code !== undefined ? { code } : {}) },
    });
}
// ---------------------------------------------------------------------------
// SmartAgentServer
// ---------------------------------------------------------------------------
export class SmartAgentServer {
    agent;
    config;
    constructor(agent, config = {}) {
        this.agent = agent;
        this.config = config;
    }
    start() {
        return new Promise((resolve, reject) => {
            const server = createServer((req, res) => {
                this._handleRequest(req, res).catch((err) => {
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(jsonError(String(err), 'server_error'));
                    }
                });
            });
            const port = this.config.port ?? 0;
            const host = this.config.host ?? '127.0.0.1';
            server.on('error', reject);
            server.listen(port, host, () => {
                const address = server.address();
                const actualPort = typeof address === 'object' && address !== null ? address.port : port;
                resolve({
                    port: actualPort,
                    close() {
                        return new Promise((resolveClose, rejectClose) => {
                            server.close((err) => {
                                if (err)
                                    rejectClose(err);
                                else
                                    resolveClose();
                            });
                        });
                    },
                });
            });
        });
    }
    async _handleRequest(req, res) {
        const { method, url: rawUrl } = req;
        const urlPath = (rawUrl || '/').split('?')[0].replace(/\/$/, '') || '/';
        if (urlPath !== '/v1/chat/completions' && urlPath !== '/chat/completions') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(jsonError(`Cannot ${method} ${rawUrl}`, 'invalid_request_error'));
            return;
        }
        if (method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(jsonError(`Method ${method} not allowed`, 'invalid_request_error'));
            return;
        }
        const rawBody = await this._readBody(req);
        let parsed;
        try {
            parsed = JSON.parse(rawBody);
        }
        catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
            return;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            !Array.isArray(parsed.messages)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonError('messages must be a non-empty array', 'invalid_request_error'));
            return;
        }
        const body = parsed;
        if (body.messages.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonError('messages must be a non-empty array', 'invalid_request_error'));
            return;
        }
        const hasUserMessage = body.messages.some((m) => m.role === 'user');
        if (!hasUserMessage) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonError('at least one message with role "user" is required', 'invalid_request_error'));
            return;
        }
        const opts = {
            temperature: body.temperature,
            maxTokens: body.max_tokens,
            topP: body.top_p,
            externalTools: body.tools,
        };
        let timeoutId;
        if (this.config.requestTimeoutMs) {
            const ctrl = new AbortController();
            timeoutId = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs);
            opts.signal = ctrl.signal;
        }
        try {
            if (body.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                });
                const id = `chatcmpl-${randomUUID()}`;
                const created = Math.floor(Date.now() / 1000);
                let firstChunk = true;
                let finishReasonSent = false;
                let lastUsage = null;
                for await (const chunk of this.agent.streamProcess(body.messages, opts)) {
                    if (!chunk.ok) {
                        const errorChunk = {
                            id,
                            object: 'chat.completion.chunk',
                            created,
                            model: 'smart-agent',
                            choices: [
                                {
                                    index: 0,
                                    delta: { content: `[Error] ${chunk.error.message}` },
                                    finish_reason: 'stop',
                                },
                            ],
                        };
                        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                        finishReasonSent = true;
                        break;
                    }
                    if (chunk.value.usage) {
                        const models = chunk.value.usage.models
                            ? Object.fromEntries(Object.entries(chunk.value.usage.models).map(([k, v]) => [
                                k,
                                {
                                    prompt_tokens: v.promptTokens,
                                    completion_tokens: v.completionTokens,
                                    total_tokens: v.totalTokens,
                                    requests: v.requests,
                                },
                            ]))
                            : undefined;
                        lastUsage = {
                            prompt_tokens: chunk.value.usage.promptTokens,
                            completion_tokens: chunk.value.usage.completionTokens,
                            total_tokens: chunk.value.usage.totalTokens,
                            ...(models ? { models } : {}),
                        };
                    }
                    const baseResponse = {
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model: 'smart-agent',
                        usage: null,
                    };
                    // First chunk should include the role
                    if (firstChunk) {
                        const firstDelta = {
                            role: 'assistant',
                            content: chunk.value.content || '',
                        };
                        if (chunk.value.toolCalls) {
                            firstDelta.tool_calls = chunk.value.toolCalls.map((call, index) => {
                                const tc = toToolCallDelta(call, index);
                                return {
                                    index: tc.index,
                                    id: tc.id,
                                    type: 'function',
                                    function: {
                                        name: tc.name,
                                        arguments: tc.arguments || '',
                                    },
                                };
                            });
                        }
                        res.write(`data: ${JSON.stringify({
                            ...baseResponse,
                            choices: [
                                {
                                    index: 0,
                                    delta: firstDelta,
                                    finish_reason: null,
                                },
                            ],
                        })}\n\n`);
                        firstChunk = false;
                        if (!chunk.value.finishReason)
                            continue;
                    }
                    // Regular content / tool call chunk
                    if ((chunk.value.content || chunk.value.toolCalls) && !firstChunk) {
                        const delta = {};
                        if (chunk.value.content)
                            delta.content = chunk.value.content;
                        if (chunk.value.toolCalls) {
                            delta.tool_calls = chunk.value.toolCalls.map((call, index) => {
                                const tc = toToolCallDelta(call, index);
                                return {
                                    index: tc.index,
                                    id: tc.id,
                                    type: 'function',
                                    function: {
                                        name: tc.name,
                                        arguments: tc.arguments || '',
                                    },
                                };
                            });
                        }
                        res.write(`data: ${JSON.stringify({
                            ...baseResponse,
                            choices: [
                                {
                                    index: 0,
                                    delta,
                                    finish_reason: null,
                                },
                            ],
                        })}\n\n`);
                    }
                    // Finish reason in a separate chunk
                    if (chunk.value.finishReason) {
                        res.write(`data: ${JSON.stringify({
                            ...baseResponse,
                            choices: [
                                {
                                    index: 0,
                                    delta: {},
                                    finish_reason: mapStopReason(chunk.value.finishReason),
                                },
                            ],
                        })}\n\n`);
                        finishReasonSent = true;
                    }
                }
                if (!finishReasonSent) {
                    res.write(`data: ${JSON.stringify({
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model: 'smart-agent',
                        usage: null,
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    })}\n\n`);
                }
                // Usage chunk if we have it
                if (lastUsage) {
                    res.write(`data: ${JSON.stringify({
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model: 'smart-agent',
                        choices: [],
                        usage: lastUsage,
                    })}\n\n`);
                }
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            const result = await this.agent.process(body.messages, opts);
            if (!result.ok) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(jsonError(result.error.message, 'server_error', result.error.code));
                return;
            }
            const message = {
                role: 'assistant',
                content: result.value.content,
            };
            if (result.value.toolCalls) {
                message.tool_calls = result.value.toolCalls;
                if (!message.content)
                    message.content = null;
            }
            const response = {
                id: `chatcmpl-${randomUUID()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: 'smart-agent',
                choices: [
                    {
                        index: 0,
                        message,
                        finish_reason: mapStopReason(result.value.stopReason),
                    },
                ],
                usage: {
                    prompt_tokens: result.value.usage?.promptTokens ?? 0,
                    completion_tokens: result.value.usage?.completionTokens ?? 0,
                    total_tokens: result.value.usage?.totalTokens ?? 0,
                    ...(result.value.usage?.models
                        ? {
                            models: Object.fromEntries(Object.entries(result.value.usage.models).map(([k, v]) => [
                                k,
                                {
                                    prompt_tokens: v.promptTokens,
                                    completion_tokens: v.completionTokens,
                                    total_tokens: v.totalTokens,
                                    requests: v.requests,
                                },
                            ])),
                        }
                        : {}),
                },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        }
        finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        }
    }
    _readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });
    }
}
//# sourceMappingURL=server.js.map