import type {
  CallOptions,
  IClientAdapter,
  IRequestLogger,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError, terminalRunError } from '@mcp-abap-adt/llm-agent';
import type { IPipeline } from '../interfaces/pipeline.js';
import { errorUsage, withUsageAttribution } from '../logger/llm-call-usage.js';
import { withPipelineRequestLogger } from '../logger/pipeline-request-logger.js';

export async function* pipelineToStream(
  pipeline: IPipeline,
  input: string | Message[],
  externalTools: LlmTool[],
  opts: CallOptions | undefined,
  clientAdapter?: IClientAdapter,
  configuredRequestLogger?: IRequestLogger,
): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
  if (!pipeline) return;

  const history = typeof input === 'string' ? [] : input;

  const chunkQueue: Result<LlmStreamChunk, OrchestratorError>[] = [];
  let resolveWait: (() => void) | null = null;
  let done = false;
  let yieldedError = false;

  const executorPromise = withPipelineRequestLogger(
    configuredRequestLogger,
    opts?.requestLogger,
    () =>
      pipeline.execute(
        input,
        history,
        opts,
        (chunk) => {
          if (!chunk.ok) yieldedError = true;
          chunkQueue.push(chunk);
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
        },
        externalTools,
        clientAdapter,
      ),
  )
    .then(({ error }) => {
      if (error && !yieldedError) {
        const terminal = terminalRunError(error);
        chunkQueue.push({
          ok: false,
          error:
            terminal && terminal !== error
              ? withUsageAttribution(terminal, errorUsage(error))
              : error,
        });
      }
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    })
    .catch((err) => {
      if (!yieldedError) {
        chunkQueue.push({
          ok: false,
          error: withUsageAttribution(
            terminalRunError(err) ??
              new OrchestratorError(String(err), 'PIPELINE_ERROR'),
            errorUsage(err),
          ),
        });
      }
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    });

  try {
    while (!done || chunkQueue.length > 0) {
      if (chunkQueue.length > 0) {
        const chunk = chunkQueue.shift();
        if (chunk !== undefined) yield chunk;
      } else if (!done) {
        await new Promise<void>((r) => {
          resolveWait = r;
        });
      }
    }
    await executorPromise;
  } finally {
    // A worker pipeline can finish logging after emitting an error chunk.
    if (configuredRequestLogger && !done) await executorPromise;
  }
}
