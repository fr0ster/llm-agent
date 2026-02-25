export interface ILogger {
  log(event: LogEvent): void;
}

export type LogEvent =
  | {
      type: 'classify';
      traceId: string;
      inputLength: number;
      subpromptCount: number;
      durationMs: number;
    }
  | { type: 'rag_upsert'; traceId: string; store: string; durationMs: number }
  | {
      type: 'rag_query';
      traceId: string;
      store: string;
      k: number;
      resultCount: number;
      results: Array<{ score: number; id: unknown; text: string }>;
      durationMs: number;
    }
  | {
      type: 'llm_call';
      traceId: string;
      iteration: number;
      finishReason: string;
      toolCallsRequested: number;
      durationMs: number;
    }
  | {
      type: 'llm_context';
      traceId: string;
      iteration: number;
      messageCount: number;
      toolCount: number;
      toolNames: string[];
      systemPromptPreview: string | null;
    }
  | {
      type: 'tool_call';
      traceId: string;
      toolName: string;
      isError: boolean;
      durationMs: number;
    }
  | {
      type: 'pipeline_done';
      traceId: string;
      stopReason: string;
      iterations: number;
      toolCallCount: number;
      durationMs: number;
    }
  | {
      type: 'pipeline_error';
      traceId: string;
      code: string;
      message: string;
      durationMs: number;
    }
  | {
      type: 'tools_selected';
      traceId: string;
      total: number;
      minScore: number;
      relevantFactsCount: number;
      selected: number;
      names: string[];
      filteredOut: number;
    }
  | {
      type: 'rag_translate';
      traceId: string;
      original: string;
      translated: string;
    }
  | {
      /** Full incoming request from the client (smart-server only). */
      type: 'client_request';
      traceId: string;
      messages: Array<{ role: string; content: string }>;
    }
  | {
      /** Final response sent back to the client (smart-server only). */
      type: 'client_response';
      traceId: string;
      content: string;
      durationMs: number;
    }
  | {
      /** Complete context sent to the LLM before each chat call. */
      type: 'llm_request';
      traceId: string;
      iteration: number;
      messages: Array<{ role: string; content: string }>;
      toolNames: string[];
    }
  | {
      /** Full LLM response after each chat call. */
      type: 'llm_response';
      traceId: string;
      iteration: number;
      content: string;
      toolCalls: Array<{ name: string; arguments: unknown }>;
      finishReason: string;
    };
