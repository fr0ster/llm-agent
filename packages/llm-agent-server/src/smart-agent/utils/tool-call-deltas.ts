import type {
  LlmToolCall,
  LlmToolCallDelta,
  StreamToolCall,
} from '@mcp-abap-adt/llm-agent';

function isLlmToolCall(call: StreamToolCall): call is LlmToolCall {
  return !('index' in call);
}

export function getStreamToolCallName(
  call: StreamToolCall,
): string | undefined {
  if (isLlmToolCall(call)) return call.name;
  return typeof call.name === 'string' ? call.name : undefined;
}

export function toToolCallDelta(
  call: StreamToolCall,
  fallbackIndex: number,
): LlmToolCallDelta {
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
