import { SmartAgentError, terminalRunError } from '@mcp-abap-adt/llm-agent';
import {
  errorUsage,
  withUsageAttribution,
} from '../../logger/llm-call-usage.js';

export type CatalogueKind = 'tool' | 'skill';

export function retrievalError<T>(
  error: T,
  kind: CatalogueKind,
  signal?: AbortSignal,
): SmartAgentError {
  const failure =
    terminalRunError(error) ??
    (signal?.aborted
      ? new SmartAgentError(
          kind === 'tool'
            ? 'Tool retrieval aborted'
            : 'Skill retrieval aborted',
          'ABORTED',
        )
      : undefined) ??
    (error instanceof SmartAgentError ? error : undefined) ??
    new SmartAgentError(
      error instanceof Error ? error.message : String(error),
      `${kind.toUpperCase()}_RETRIEVAL_FAILED`,
    );
  return failure === error
    ? failure
    : withUsageAttribution(failure, errorUsage(error));
}
