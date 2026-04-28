import type { ILlm } from '../interfaces/llm.js';
import type { IRequestLogger } from '../interfaces/request-logger.js';
import {
  type CallOptions,
  RagError,
  type Result,
} from '../interfaces/types.js';
export interface IQueryExpander {
  expand(
    query: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}
export declare class NoopQueryExpander implements IQueryExpander {
  expand(
    query: string,
    _options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}
export declare class LlmQueryExpander implements IQueryExpander {
  private readonly llm;
  private readonly requestLogger?;
  constructor(llm: ILlm, requestLogger?: IRequestLogger | undefined);
  expand(
    query: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}
//# sourceMappingURL=query-expander.d.ts.map
