import type {
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
} from '../interfaces/rag.js';
import { isBatchEmbedder, isBatchSizeLimited } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';

class InputCapEmbedder implements IEmbedder {
  constructor(
    protected readonly inner: IEmbedder,
    private readonly maxInputChars: number,
  ) {
    if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 0) {
      throw new RangeError('maxInputChars must be a nonnegative safe integer');
    }
  }

  get getMaxInputChars() {
    return this.inner.getMaxInputChars?.bind(this.inner);
  }

  get maxBatchSize() {
    return isBatchSizeLimited(this.inner) ? this.inner.maxBatchSize : undefined;
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.inner.embed(
      options?.preserveEmbeddingInput || this.maxInputChars === 0
        ? text
        : text.slice(0, this.maxInputChars),
      options,
    );
  }
}

class InputCapBatchEmbedder extends InputCapEmbedder implements IEmbedderBatch {
  constructor(
    protected readonly inner: IEmbedderBatch,
    maxInputChars: number,
  ) {
    super(inner, maxInputChars);
  }

  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]> {
    return this.inner.embedBatch(texts, options);
  }
}

export function withInputCap(
  inner: IEmbedder,
  maxInputChars = 24000,
): IEmbedder {
  return isBatchEmbedder(inner)
    ? new InputCapBatchEmbedder(inner, maxInputChars)
    : new InputCapEmbedder(inner, maxInputChars);
}
