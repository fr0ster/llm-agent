import {
  type ILlm,
  type ISubAgent,
  type ISubAgentInput,
  type ISubAgentResult,
  OrchestratorError,
  type SubAgentCapabilities,
} from '@mcp-abap-adt/llm-agent';

import { ContextAssembler } from '../context/context-assembler.js';

export interface DirectLlmSubAgentOptions {
  /** Deployment IANA time zone. Default: UTC. */
  timeZone?: string;
  systemPrompt: string;
  workerBase?: string;
  description?: string;
  contextPolicy?: 'required' | 'optional' | 'forbidden';
}

/**
 * A leaf-node subagent that performs one LLM chat call over the provided
 * (system prompt + context + task). No RAG, no MCP, no tool-loop, no skills.
 *
 * `contextPolicy` defaults to 'required' — most use cases for the constrained
 * type expect the orchestrator to inject relevant material. Set 'optional'
 * for cases where the task is self-contained.
 */
export class DirectLlmSubAgent implements ISubAgent {
  public readonly description?: string;
  public readonly capabilities: SubAgentCapabilities;
  private readonly assembler: ContextAssembler;

  constructor(
    public readonly name: string,
    private readonly llm: ILlm,
    opts: DirectLlmSubAgentOptions,
  ) {
    this.description = opts.description;
    this.assembler = new ContextAssembler({
      timeZone: opts.timeZone,
      systemPromptPreamble: [opts.workerBase, opts.systemPrompt]
        .filter((part) => part !== undefined)
        .join('\n\n'),
    });
    this.capabilities = {
      contextPolicy: opts.contextPolicy ?? 'required',
    };
  }

  get model(): string | undefined {
    return this.llm.model;
  }

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    if (
      this.capabilities.contextPolicy === 'required' &&
      (!input.context || input.context.length === 0)
    ) {
      throw new Error(
        `DirectLlmSubAgent '${this.name}': context is required but was not provided`,
      );
    }

    const userContent =
      input.context && input.context.length > 0
        ? `${input.context}\n\n${input.task}`
        : input.task;

    const assembled = await this.assembler.assemble(
      { type: 'action', text: userContent },
      { ragResults: {}, tools: [] },
      [...(input.history ?? []), { role: 'user', content: userContent }],
      { requestStartedAt: input.requestStartedAt, signal: input.signal },
    );
    if (!assembled.ok) throw assembled.error;

    try {
      input.onActivity?.('llm call');
    } catch {
      // Supervision is informational: an observer must never fail the work.
    }
    const res = await this.llm.chat(assembled.value, [], {
      caller: input.caller,
      usage: input.usage,
      signal: input.signal,
      sessionId: input.sessionId,
    });
    if (!res.ok) {
      throw res.error;
    }
    const { content, finishReason, usage } = res.value;
    const error =
      finishReason === 'length'
        ? new OrchestratorError(
            'LLM response was truncated at a token limit.',
            'LLM_OUTPUT_TRUNCATED',
          )
        : !content.trim()
          ? new OrchestratorError(
              'Worker returned an empty terminal response.',
              'EMPTY_WORKER_OUTPUT',
            )
          : undefined;
    const model = this.model;
    if (error) throw Object.assign(error, { usage, model });

    return {
      output: content,
      usage,
      model,
    };
  }
}
