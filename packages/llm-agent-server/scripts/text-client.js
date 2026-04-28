/**
 * Interactive text client for SmartServer.
 *
 * Connects to the OpenAI-compatible endpoint and provides a terminal chat
 * interface with streaming responses, session persistence, and conversation
 * history display.
 *
 * Usage:
 *   npm run client:text
 *   PORT=5000 npm run client:text
 *
 * Commands:
 *   /clear   — reset conversation history
 *   /session — show current session ID
 *   /exit    — quit (or Ctrl+C / Ctrl+D)
 */
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
const PORT = Number(process.env.PORT || 4004);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_ID = process.env.SESSION_ID || randomUUID();
const history = [];
// ---------------------------------------------------------------------------
// SSE streaming request
// ---------------------------------------------------------------------------
function streamChat(messages) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: 'smart-agent',
            stream: true,
            messages,
        });
        const req = request({
            hostname: HOST,
            port: PORT,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Id': SESSION_ID,
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                let body = '';
                res.on('data', (c) => (body += c.toString()));
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body}`)));
                return;
            }
            let fullContent = '';
            let buffer = '';
            res.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                // Keep last potentially incomplete line in buffer
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(':'))
                        continue;
                    if (trimmed.startsWith('data: ')) {
                        const data = trimmed.slice(6).trim();
                        if (data === '[DONE]')
                            continue;
                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content || '';
                            if (content) {
                                process.stdout.write(content);
                                fullContent += content;
                            }
                        }
                        catch {
                            // Incomplete JSON, skip
                        }
                    }
                }
            });
            res.on('end', () => {
                process.stdout.write('\n\n');
                resolve(fullContent);
            });
        });
        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------
const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
});
console.log(`SmartAgent text client`);
console.log(`Server:  http://${HOST}:${PORT}`);
console.log(`Session: ${SESSION_ID}`);
console.log(`Commands: /clear /session /exit\n`);
rl.prompt();
rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
        rl.prompt();
        return;
    }
    // Slash commands
    if (input === '/exit' || input === '/quit') {
        console.log('Bye.');
        process.exit(0);
    }
    if (input === '/clear') {
        history.length = 0;
        console.log('History cleared.\n');
        rl.prompt();
        return;
    }
    if (input === '/session') {
        console.log(`Session: ${SESSION_ID}\n`);
        rl.prompt();
        return;
    }
    history.push({ role: 'user', content: input });
    try {
        const response = await streamChat(history);
        if (response) {
            history.push({ role: 'assistant', content: response });
        }
    }
    catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}\n`);
    }
    rl.prompt();
});
rl.on('close', () => {
    console.log('\nBye.');
    process.exit(0);
});
//# sourceMappingURL=text-client.js.map