import type {
  FinalizerInput,
  FinalizerResult,
  IFinalizer,
} from '@mcp-abap-adt/llm-agent';

/**
 * Deterministic markdown join over the execution trace. No LLM. Useful
 * when the plan is already shaped per-section and the answer is just
 * the concatenation of the section outputs.
 */
export class TemplateFinalizer implements IFinalizer {
  readonly name = 'template';

  async finalize(input: FinalizerInput): Promise<FinalizerResult> {
    let out = '';
    for (const t of input.executionTrace) {
      out += `# Node ${t.nodeId} — ${t.goal}\n${t.output}\n\n`;
    }
    return { output: out };
  }
}
