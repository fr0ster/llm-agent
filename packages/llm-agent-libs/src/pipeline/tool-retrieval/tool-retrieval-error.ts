import { SmartAgentError, terminalRunError } from '@mcp-abap-adt/llm-agent';
import {
  errorUsage,
  withUsageAttribution,
} from '../../logger/llm-call-usage.js';

export function toolRetrievalError<T>(
  error: T,
  signal?: AbortSignal,
): SmartAgentError {
  const failure =
    terminalRunError(error) ??
    (signal?.aborted
      ? new SmartAgentError('Tool retrieval aborted', 'ABORTED')
      : undefined) ??
    (error instanceof SmartAgentError ? error : undefined) ??
    new SmartAgentError(
      error instanceof Error ? error.message : String(error),
      'TOOL_RETRIEVAL_FAILED',
    );
  return failure === error
    ? failure
    : withUsageAttribution(failure, errorUsage(error));
}
