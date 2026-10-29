import type {
  ILlm,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  SubAgentCapabilities,
} from '@mcp-abap-adt/llm-agent';

import { ContextAssembler } from '../context/context-assembler.js';

export interface DirectLlmSubAgentOptions {
  /** Deployment IANA time zone. Default: UTC. */
  timeZone?: string;
  systemPrompt: string;
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
      systemPromptPreamble: opts.systemPrompt,
    });
    this.capabilities = {
      contextPolicy: opts.contextPolicy ?? 'required',
    };
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
      [],
      { requestStartedAt: input.requestStartedAt, signal: input.signal },
    );
    if (!assembled.ok) throw assembled.error;

    const res = await this.llm.chat(assembled.value, [], {
      usage: input.usage,
      signal: input.signal,
      sessionId: input.sessionId,
    });
    if (!res.ok) {
      throw res.error;
    }

    return {
      output: res.value.content,
      usage: res.value.usage,
    };
  }
}
