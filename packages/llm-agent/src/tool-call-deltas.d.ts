import type { LlmToolCallDelta, StreamToolCall } from '@mcp-abap-adt/llm-agent';
export declare function getStreamToolCallName(call: StreamToolCall): string | undefined;
export declare function toToolCallDelta(call: StreamToolCall, fallbackIndex: number): LlmToolCallDelta;
//# sourceMappingURL=tool-call-deltas.d.ts.map