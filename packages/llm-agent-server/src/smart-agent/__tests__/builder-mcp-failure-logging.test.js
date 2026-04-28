/**
 * Regression test for issue #118 — SmartAgentBuilder must surface MCP setup
 * failures via the logger instead of swallowing them silently.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
function stubLlm() {
    return {
        async chat(_messages, _tools, _options) {
            return {
                ok: true,
                value: {
                    content: 'ok',
                    toolCalls: [],
                    finishReason: 'stop',
                },
            };
        },
        async *streamChat(_messages, _tools, _options) {
            yield {
                ok: true,
                value: { content: 'ok', finishReason: 'stop' },
            };
        },
    };
}
class CapturingLogger {
    events = [];
    log(event) {
        this.events.push(event);
    }
}
describe('SmartAgentBuilder — MCP setup failure logging (#118)', () => {
    it('logs a warning when an MCP connection fails instead of swallowing it', async () => {
        const { SmartAgentBuilder } = await import('../builder.js');
        const logger = new CapturingLogger();
        // Port 1 is reserved/unbound on every sane host → connect must fail.
        const unreachableUrl = 'http://127.0.0.1:1/mcp/stream/http';
        const handle = await new SmartAgentBuilder({
            mcp: { type: 'http', url: unreachableUrl },
        })
            .withMainLlm(stubLlm())
            .withLogger(logger)
            .build();
        try {
            const warnings = logger.events.filter((e) => e.type === 'warning');
            const mcpWarning = warnings.find((w) => w.message.includes(unreachableUrl));
            assert.ok(mcpWarning, `expected a 'warning' log entry mentioning ${unreachableUrl}, got: ${JSON.stringify(warnings)}`);
            assert.match(mcpWarning.message, /MCP setup failed/);
            // Agent still builds (graceful degradation contract preserved).
            const health = await handle.agent.healthCheck();
            assert.ok(health.ok);
            assert.equal(health.value.mcp.length, 0);
        }
        finally {
            await handle.close();
        }
    });
});
//# sourceMappingURL=builder-mcp-failure-logging.test.js.map