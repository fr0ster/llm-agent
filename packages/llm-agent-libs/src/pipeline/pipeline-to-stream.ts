import type {
  CallOptions,
  IClientAdapter,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError, SmartAgentError } from '@mcp-abap-adt/llm-agent';
import type { IPipeline } from '../interfaces/pipeline.js';

export async function* pipelineToStream(
  pipeline: IPipeline,
  input: string | Message[],
  externalTools: LlmTool[],
  opts: CallOptions | undefined,
  clientAdapter?: IClientAdapter,
): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
  if (!pipeline) return;

  const history = typeof input === 'string' ? [] : input;

  const chunkQueue: Result<LlmStreamChunk, OrchestratorError>[] = [];
  let resolveWait: (() => void) | null = null;
  let done = false;
  let yieldedError = false;

  const executorPromise = pipeline
    .execute(
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
    )
    .then(({ error }) => {
      if (error && !yieldedError) chunkQueue.push({ ok: false, error });
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    })
    .catch((err) => {
      if (!yieldedError)
        chunkQueue.push({
          ok: false,
          error:
            err instanceof SmartAgentError
              ? err
              : new OrchestratorError(String(err), 'PIPELINE_ERROR'),
        });
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    });

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
}
