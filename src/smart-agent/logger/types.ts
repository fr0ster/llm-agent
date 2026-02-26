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
      durationMs: number;
    }
  | {
      type: 'llm_call';
      traceId: string;
      iteration: number;
      finishReason: string;
      durationMs: number;
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
      selected: number;
      names: string[];
    }
  | {
      type: 'rag_translate';
      traceId: string;
      original: string;
      translated: string;
    };
