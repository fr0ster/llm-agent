import { LlmError, type LlmFinishReason } from '@mcp-abap-adt/llm-agent';

export function llmOutputTruncation(
  finishReason?: LlmFinishReason,
): LlmError | undefined {
  if (finishReason === 'length')
    return new LlmError(
      'LLM response was truncated at a token limit.',
      'LLM_OUTPUT_TRUNCATED',
    );
}
