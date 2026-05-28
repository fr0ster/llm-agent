import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '@mcp-abap-adt/llm-agent';

/**
 * Default finalizer. Returns the interpreter's already-joined output
 * verbatim — exactly what the DAG coordinator yielded before IFinalizer
 * was introduced. No LLM call; no usage attributed.
 */
export class PassthroughFinalizer implements IFinalizer {
  readonly name = 'passthrough';

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    return { output: input.interpreterOutput };
  }
}
