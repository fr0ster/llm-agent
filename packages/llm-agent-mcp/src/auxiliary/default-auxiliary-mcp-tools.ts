import type {
  CallOptions,
  IAuxiliaryMcpTools,
  IUsageRecorder,
  McpError as McpErrorType,
  McpTool,
  McpToolResult,
  Result,
  UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import type { AuxToolEntry } from './wait-tool.js';

/**
 * Our example `IAuxiliaryMcpTools`: a fixed list of in-process tool entries.
 * `listTools` returns their defs; `callTool` routes by name to the handler.
 * An unknown name is a tool-level error (NOT thrown — never "unavailable").
 * A handler that REJECTS (e.g. `wait` on abort) propagates unchanged.
 */
export class DefaultAuxiliaryMcpTools implements IAuxiliaryMcpTools {
  private readonly byName: Map<string, AuxToolEntry>;

  constructor(
    private readonly entries: AuxToolEntry[],
    private readonly usage?: IUsageRecorder,
  ) {
    this.byName = new Map(entries.map((e) => [e.def.name, e]));
  }

  async listTools(): Promise<Result<McpTool[], McpErrorType>> {
    return { ok: true, value: this.entries.map((e) => e.def) };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpErrorType>> {
    const entry = this.byName.get(name);
    if (!entry) {
      return {
        ok: false,
        error: new McpError(`unknown auxiliary tool: ${name}`),
      };
    }
    const recorder = options?.usage ?? this.usage;
    if (!recorder) return entry.handler(args, options);
    const started = performance.now();
    let outcome: 'ok' | 'error' | 'aborted' = 'error';
    let toolOutcome: 'ok' | 'error' | undefined;
    let responseBytes: number | undefined;
    let errorCode: string | undefined;
    const requestBytes = serializedBytes({
      name,
      arguments: args,
    });
    try {
      const response = await entry.handler(args, options);
      responseBytes = serializedBytes(response);
      try {
        toolOutcome =
          !response.ok || response.value.isError === true ? 'error' : 'ok';
      } catch {
        /* Inspecting an unusual result must not change the dispatch outcome. */
      }
      outcome = 'ok';
      return response;
    } catch (error) {
      outcome =
        options?.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
          ? 'aborted'
          : 'error';
      try {
        if (typeof error === 'object' && error !== null) {
          for (const key of ['code', 'status'] as const) {
            const value =
              key in error
                ? (error as Record<string, unknown>)[key]
                : undefined;
            const code =
              typeof value === 'number' && Number.isFinite(value)
                ? String(value)
                : value;
            if (
              typeof code === 'string' &&
              /^[A-Za-z0-9_.:-]{1,128}$/.test(code)
            ) {
              errorCode = code;
              break;
            }
          }
        }
      } catch {
        /* Error inspection must preserve the original failure. */
      }
      throw error;
    } finally {
      try {
        const record: UsageInput = {
          kind: 'tool.call',
          context: {},
          tool: name,
          dispatched: true,
          embedded: true,
          outcome: outcome === 'ok' ? (toolOutcome ?? 'ok') : outcome,
          transportOutcome: outcome,
          toolOutcome,
          errorCode,
          durationMs: performance.now() - started,
          requestBytes,
          responseBytes,
        };
        recorder.record(record);
      } catch {
        /* Analytics must not affect tool execution. */
      }
    }
  }
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? undefined
      : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return undefined;
  }
}
