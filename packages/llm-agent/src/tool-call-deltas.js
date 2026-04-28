function isLlmToolCall(call) {
    return !('index' in call);
}
export function getStreamToolCallName(call) {
    if (isLlmToolCall(call))
        return call.name;
    return typeof call.name === 'string' ? call.name : undefined;
}
export function toToolCallDelta(call, fallbackIndex) {
    if (isLlmToolCall(call)) {
        return {
            index: fallbackIndex,
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
        };
    }
    return {
        index: call.index,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
    };
}
//# sourceMappingURL=tool-call-deltas.js.map