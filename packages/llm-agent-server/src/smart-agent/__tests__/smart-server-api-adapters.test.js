// src/smart-agent/__tests__/smart-server-api-adapters.test.ts
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { SmartServer } from '../smart-server.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function httpRequest(port, method, path, body) {
    return new Promise((resolve, reject) => {
        const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
        const options = {
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
                'Content-Type': 'application/json',
                ...(bodyStr !== undefined
                    ? { 'Content-Length': Buffer.byteLength(bodyStr) }
                    : {}),
            },
        };
        const req = request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try {
                    parsed = JSON.parse(text);
                }
                catch {
                    parsed = text;
                }
                resolve({ status: res.statusCode ?? 0, body: parsed, raw: text });
            });
        });
        req.on('error', reject);
        if (bodyStr !== undefined) {
            req.write(bodyStr);
        }
        req.end();
    });
}
function makeFakeAdapter(overrides) {
    return {
        name: 'anthropic',
        normalizeRequest(req) {
            const r = req;
            return {
                messages: [{ role: 'user', content: String(r.prompt ?? 'hello') }],
                stream: false,
                context: { adapterName: 'anthropic', protocol: { model: r.model } },
            };
        },
        async *transformStream(_source, _ctx) { },
        formatResult(_res, _ctx) {
            return {
                type: 'message',
                content: [{ type: 'text', text: _res.content }],
            };
        },
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SmartServer — Anthropic /v1/messages route', () => {
    it('returns 404 when Anthropic adapter is disabled', async () => {
        const server = new SmartServer({
            port: 0,
            llm: { apiKey: 'test-key' },
            skipModelValidation: true,
            disableBuiltInAdapters: true,
            apiAdapters: [],
        });
        const handle = await server.start();
        try {
            const res = await httpRequest(handle.port, 'POST', '/v1/messages', {
                model: 'claude-3',
                messages: [{ role: 'user', content: 'hi' }],
            });
            assert.equal(res.status, 404);
            const body = res.body;
            assert.ok(body.error?.message?.includes('not registered'));
        }
        finally {
            await handle.close();
        }
    });
    it('returns 400 for invalid JSON on /v1/messages', async () => {
        const server = new SmartServer({
            port: 0,
            llm: { apiKey: 'test-key' },
            skipModelValidation: true,
            apiAdapters: [makeFakeAdapter()],
        });
        const handle = await server.start();
        try {
            // Send raw invalid JSON
            const res = await new Promise((resolve, reject) => {
                const req = request({
                    host: '127.0.0.1',
                    port: handle.port,
                    method: 'POST',
                    path: '/v1/messages',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength('{invalid'),
                    },
                }, (resp) => {
                    const chunks = [];
                    resp.on('data', (c) => chunks.push(c));
                    resp.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let parsed;
                        try {
                            parsed = JSON.parse(text);
                        }
                        catch {
                            parsed = text;
                        }
                        resolve({ status: resp.statusCode ?? 0, body: parsed });
                    });
                });
                req.on('error', reject);
                req.write('{invalid');
                req.end();
            });
            assert.equal(res.status, 400);
            const body = res.body;
            assert.ok(body.error?.message?.includes('Invalid JSON'));
        }
        finally {
            await handle.close();
        }
    });
    it('routes /messages (without /v1 prefix) to Anthropic adapter', async () => {
        const server = new SmartServer({
            port: 0,
            llm: { apiKey: 'test-key' },
            skipModelValidation: true,
            disableBuiltInAdapters: true,
            apiAdapters: [],
        });
        const handle = await server.start();
        try {
            const res = await httpRequest(handle.port, 'POST', '/messages', {
                model: 'claude-3',
                messages: [{ role: 'user', content: 'hi' }],
            });
            // Should hit the route (404 because adapter not registered, not 404 "Cannot POST")
            assert.equal(res.status, 404);
            const body = res.body;
            assert.ok(body.error?.message?.includes('not registered'));
        }
        finally {
            await handle.close();
        }
    });
});
//# sourceMappingURL=smart-server-api-adapters.test.js.map