import { request } from 'node:http';
const PORT = process.env.PORT || 4004;
const HOST = '127.0.0.1';
const payload = {
    model: 'smart-agent',
    stream: true,
    messages: [
        {
            role: 'user',
            content: process.argv[2] ||
                'Розкажи дуже коротку казку про робота, який вчився програмувати.',
        },
    ],
};
console.log(`\n🚀 Streaming request to http://${HOST}:${PORT}/v1/chat/completions\n`);
const req = request({
    hostname: HOST,
    port: Number(PORT),
    path: '/v1/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
}, (res) => {
    res.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            // SSE heartbeat comment
            if (trimmed.startsWith(': heartbeat ')) {
                console.log(`\n💓 ${trimmed}`);
                continue;
            }
            // SSE timing comment
            if (trimmed.startsWith(': timing ')) {
                console.log(`\n⏱️  ${trimmed}`);
                continue;
            }
            // Other SSE comments
            if (trimmed.startsWith(':')) {
                continue;
            }
            // Data lines
            if (trimmed.startsWith('data: ')) {
                const data = trimmed.slice(6).trim();
                if (data === '[DONE]') {
                    console.log('\n\n✅ Stream finished [DONE]');
                    process.exit(0);
                }
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices[0]?.delta?.content || '';
                    if (content)
                        process.stdout.write(content);
                }
                catch {
                    // Incomplete JSON chunk, ignore
                }
            }
        }
    });
});
req.on('error', (e) => {
    console.error(`❌ Error: ${e.message}`);
    process.exit(1);
});
req.write(JSON.stringify(payload));
req.end();
//# sourceMappingURL=test-stream-client.js.map