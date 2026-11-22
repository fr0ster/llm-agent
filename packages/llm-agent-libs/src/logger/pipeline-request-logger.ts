import { AsyncLocalStorage } from 'node:async_hooks';
import type { IRequestLogger } from '@mcp-abap-adt/llm-agent';

const pipelineRequest = new AsyncLocalStorage<{
  configured: IRequestLogger;
  scoped: IRequestLogger;
}>();

/** Binds legacy pipelines that read their logger from initialize() to each worker run. */
export function pipelineRequestLogger(
  configured: IRequestLogger,
): IRequestLogger {
  const activeLogger = () => {
    const scope = pipelineRequest.getStore();
    return scope?.configured === configured ? scope.scoped : configured;
  };
  return {
    logLlmCall: (entry) => activeLogger().logLlmCall(entry),
    logRagQuery: (entry) => activeLogger().logRagQuery(entry),
    logToolCall: (entry) => activeLogger().logToolCall(entry),
    // The agent owns the scoped logger's lifecycle.
    startRequest: (requestId) => {
      if (activeLogger() === configured) configured.startRequest(requestId);
    },
    endRequest: (requestId) => {
      if (activeLogger() === configured) configured.endRequest(requestId);
    },
    dropRequest: (requestId) => {
      if (activeLogger() === configured) configured.dropRequest(requestId);
    },
    getSummary: (requestId) => activeLogger().getSummary(requestId),
    reset: () => {
      if (activeLogger() === configured) configured.reset();
    },
  };
}

export function withPipelineRequestLogger<T>(
  configured: IRequestLogger | undefined,
  scoped: IRequestLogger | undefined,
  execute: () => T,
): T {
  return configured && scoped
    ? pipelineRequest.run({ configured, scoped }, execute)
    : execute();
}
