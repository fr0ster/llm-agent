import type {
  CallOptions,
  McpError as McpErrorType,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { cancelableDelay } from './cancelable-delay.js';

export interface AuxToolEntry {
  def: McpTool;
  handler: (
    args: Record<string, unknown>,
    options?: CallOptions,
  ) => Promise<Result<McpToolResult, McpErrorType>>;
}

export const DEFAULT_WAIT_MAX_SECONDS = 60;

/**
 * The `wait` auxiliary tool: pause N seconds (clamped to `maxSeconds`) before
 * continuing. Honors `options.signal` via `cancelableDelay` — an abort
 * propagates (rejects). Invalid `seconds` is a tool-level error (returned,
 * not thrown).
 */
export function makeWaitTool(
  maxSeconds: number = DEFAULT_WAIT_MAX_SECONDS,
): AuxToolEntry {
  return {
    def: {
      name: 'wait',
      description:
        'Pause for the given number of seconds before continuing. Use after ' +
        'an asynchronous create/activate operation, before verifying, to let ' +
        `the system settle. Maximum ${maxSeconds} seconds.`,
      inputSchema: {
        type: 'object',
        properties: { seconds: { type: 'number', minimum: 0 } },
        required: ['seconds'],
        additionalProperties: false,
      },
    },
    handler: async (args, options) => {
      const raw = (args as { seconds?: unknown }).seconds;
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        return {
          ok: false,
          error: new McpError("wait: 'seconds' must be a non-negative number"),
        };
      }
      const clamped = Math.min(raw, maxSeconds);
      await cancelableDelay(clamped * 1000, options?.signal);
      const note =
        clamped < raw ? ` (requested ${raw}, capped at ${maxSeconds})` : '';
      return { ok: true, value: { content: `Waited ${clamped}s${note}` } };
    },
  };
}
