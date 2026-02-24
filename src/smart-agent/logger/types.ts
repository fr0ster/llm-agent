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
    };
