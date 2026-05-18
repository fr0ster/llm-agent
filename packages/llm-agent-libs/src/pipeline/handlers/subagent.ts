/**
 * SubAgentHandler — delegates a task to a named sub-agent from the registry.
 *
 * Reads:  `ctx.inputText` (default task template), `ctx.sessionId`, `ctx.options`
 * Writes: `ctx.subResults.<agent>` (or custom path via `config.outputTo`)
 *
 * Stage config:
 *   agent:    string  — registry key (required)
 *   task:     string  — Handlebars-style template for the task; defaults to '{{inputText}}'
 *   outputTo: string  — dot-path to write result output; defaults to `subResults.<agent>`
 */

import type {
  ISubAgent,
  ISubAgentResult,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import type { ISpan } from '../../tracer/types.js';
import { resolveTemplate, setPath } from '../../util/template.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

interface SubAgentStageConfig {
  agent: string;
  task?: string;
  outputTo?: string;
}

export class SubAgentHandler implements IStageHandler {
  constructor(private readonly registry: SubAgentRegistry) {}

  async execute(
    ctx: PipelineContext,
    rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    const config = rawConfig as unknown as SubAgentStageConfig;

    if (!config.agent || typeof config.agent !== 'string') {
      ctx.error = new OrchestratorError(
        "subagent stage: 'agent' is required",
        'SUBAGENT_CONFIG_ERROR',
      );
      return false;
    }

    const sub: ISubAgent | undefined = this.registry.get(config.agent);
    if (!sub) {
      ctx.error = new OrchestratorError(
        `subagent '${config.agent}' not found. Registered: ${
          [...this.registry.keys()].join(', ') || '(none)'
        }`,
        'SUBAGENT_NOT_FOUND',
      );
      return false;
    }

    const taskTemplate = config.task ?? '{{inputText}}';
    const task = resolveTemplate(
      taskTemplate,
      ctx as unknown as Record<string, unknown>,
    );

    const signal = ctx.options?.signal;
    let result: ISubAgentResult;
    try {
      result = await sub.run({
        task,
        sessionId: ctx.sessionId,
        signal,
      });
    } catch (err) {
      ctx.error = new OrchestratorError(
        err instanceof Error ? err.message : String(err),
        'SUBAGENT_RUNTIME_ERROR',
      );
      return false;
    }

    const outputPath = config.outputTo ?? `subResults.${config.agent}`;
    const ctxRecord = ctx as unknown as Record<string, unknown>;
    if (!ctxRecord.subResults) ctxRecord.subResults = {};
    setPath(ctxRecord, outputPath, result.output);

    ctx.options?.sessionLogger?.logStep(`subagent_${config.agent}`, {
      task: task.slice(0, 200),
      outputLength: result.output.length,
      usage: result.usage,
    });

    return true;
  }
}
