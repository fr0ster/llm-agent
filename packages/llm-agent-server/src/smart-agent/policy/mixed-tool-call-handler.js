export function fireInternalToolsAsync(content, internalCalls, registry, sessionId, ctx) {
    const assistantMessage = {
        role: 'assistant',
        content: content || null,
        tool_calls: internalCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
            },
        })),
    };
    const internalPromise = Promise.all(internalCalls.map(async (tc) => {
        try {
            const client = ctx.toolClientMap.get(tc.name);
            if (!client) {
                return { toolCallId: tc.id, toolName: tc.name, text: '' };
            }
            const res = await client.callTool(tc.name, tc.arguments, ctx.options);
            const text = !res.ok
                ? res.error.message
                : typeof res.value.content === 'string'
                    ? res.value.content
                    : JSON.stringify(res.value.content);
            if (res.ok)
                ctx.toolCache.set(tc.name, tc.arguments, res.value);
            ctx.metrics.toolCallCount.add();
            ctx.options?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
                arguments: tc.arguments,
                result: text,
            });
            return { toolCallId: tc.id, toolName: tc.name, text };
        }
        catch (err) {
            return {
                toolCallId: tc.id,
                toolName: tc.name,
                text: `Error: ${String(err)}`,
            };
        }
    }));
    registry.set(sessionId, {
        assistantMessage,
        promise: internalPromise,
        createdAt: Date.now(),
    });
}
//# sourceMappingURL=mixed-tool-call-handler.js.map