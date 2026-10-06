import type {
  CallOptions,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import type { IPipeline } from '../interfaces/pipeline.js';

export async function* pipelineToStream(
  pipeline: IPipeline,
  input: string | Message[],
  externalTools: LlmTool[],
  opts: CallOptions | undefined,
): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
  if (!pipeline) return;

  const history = typeof input === 'string' ? [] : input;

  const chunkQueue: Result<LlmStreamChunk, OrchestratorError>[] = [];
  let resolveWait: (() => void) | null = null;
  let done = false;
  // Spec §10.5.2 (D70): a handler that yielded its own error chunk is not
  // reported twice from the PipelineResult.
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
    )
    .then((result) => {
      // Spec §10.5.2 (D70): the PipelineResult's error reaches the consumer,
      // once — as the last item.
      if (result?.error && !yieldedError) {
        chunkQueue.push({ ok: false, error: result.error });
      }
      done = true;
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    })
    .catch((err) => {
      chunkQueue.push({
        ok: false,
        // A rejected OrchestratorError keeps its own code (spec D70).
        error:
          err instanceof OrchestratorError
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
