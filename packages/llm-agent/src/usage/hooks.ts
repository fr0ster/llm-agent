import { randomUUID } from 'node:crypto';
import type { CallOptions } from '../interfaces/types.js';
import type {
  IUsageRecorder,
  UsageInput,
  UsageOperation,
} from '../interfaces/usage.js';

export const noopUsageRecorder: IUsageRecorder = {
  record() {},
  with() {
    return noopUsageRecorder;
  },
};
export function resolveRecorder(
  opts?: { usage?: IUsageRecorder },
  bound?: IUsageRecorder,
): IUsageRecorder {
  return opts?.usage ?? bound ?? noopUsageRecorder;
}
export function startOperation(opts?: CallOptions): UsageOperation {
  let seq = 0;
  return (
    opts?.usageOp ?? {
      operationId: randomUUID(),
      seq: { next: () => seq++ },
      outerAttempt: 0,
      providerAttempt: 0,
      chunkPath: '',
    }
  );
}
export function withOuterAttempt(
  op: UsageOperation,
  n: number,
): UsageOperation {
  return { ...op, outerAttempt: n };
}
export function withProviderAttempt(
  op: UsageOperation,
  n: number,
): UsageOperation {
  return { ...op, providerAttempt: n };
}
export function withChunk(
  op: UsageOperation,
  index: number,
  total: number,
): UsageOperation {
  return {
    ...op,
    chunkPath: [op.chunkPath, `${index + 1}/${total}`]
      .filter(Boolean)
      .join('>'),
  };
}
type Facts<K extends UsageInput['kind']> = Omit<
  Extract<UsageInput, { kind: K }>,
  | 'kind'
  | 'context'
  | 'id'
  | 'at'
  | 'operationId'
  | 'physicalSeq'
  | 'outerAttempt'
  | 'providerAttempt'
  | 'chunkPath'
>;
export type LlmRequestFacts = Facts<'llm.call'>;
export type EmbeddingRequestFacts = Facts<'embedding.call'>;

// Codes are identifiers or numeric status codes, never free-form messages.
function safeCode(value: unknown): string | undefined {
  const code =
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(code)
    ? code
    : undefined;
}
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  // Getters on a provider error may throw; inspecting it must never replace
  // the original failure.
  try {
    return (
      safeCode('code' in error ? error.code : undefined) ??
      safeCode('status' in error ? error.status : undefined)
    );
  } catch {
    return undefined;
  }
}
export function reportLlmRequest(
  opts: CallOptions | undefined,
  op: UsageOperation,
  facts: LlmRequestFacts,
  bound?: IUsageRecorder,
): void {
  try {
    resolveRecorder(opts, bound).record({
      ...facts,
      errorCode: safeCode(facts.errorCode),
      kind: 'llm.call',
      context: {},
      operationId: op.operationId,
      physicalSeq: op.seq.next(),
      outerAttempt: op.outerAttempt,
      providerAttempt: op.providerAttempt,
    });
  } catch {
    /* Recording must never affect the physical request. */
  }
}
export function reportEmbeddingRequest(
  opts: CallOptions | undefined,
  op: UsageOperation,
  facts: EmbeddingRequestFacts,
  bound?: IUsageRecorder,
): void {
  try {
    resolveRecorder(opts, bound).record({
      ...facts,
      errorCode: safeCode(facts.errorCode),
      kind: 'embedding.call',
      context: {},
      operationId: op.operationId,
      physicalSeq: op.seq.next(),
      outerAttempt: op.outerAttempt,
      providerAttempt: op.providerAttempt,
      chunkPath: op.chunkPath,
    });
  } catch {
    /* Recording must never affect the physical request. */
  }
}
type EndFacts<F> = Partial<F> & {
  outcome: UsageInput['outcome'];
  error?: unknown;
};
export interface LlmRequestHandle {
  end(facts: EndFacts<LlmRequestFacts>): void;
  firstToken(): void;
}
export interface EmbeddingRequestHandle {
  end(facts: EndFacts<EmbeddingRequestFacts>): void;
  firstToken(): void;
}
export function beginLlmRequest(
  opts: CallOptions | undefined,
  op: UsageOperation,
  base: Omit<LlmRequestFacts, 'outcome' | 'durationMs' | 'tokensSource'> &
    Partial<LlmRequestFacts>,
  bound?: IUsageRecorder,
): LlmRequestHandle {
  const started = performance.now();
  let ended = false;
  let firstTokenMs: number | undefined;
  return {
    firstToken() {
      if (!ended && firstTokenMs === undefined)
        firstTokenMs = performance.now() - started;
    },
    end(facts) {
      if (ended) return;
      ended = true;
      const { error, ...rest } = facts;
      reportLlmRequest(
        opts,
        op,
        {
          tokensSource: 'unknown',
          ...base,
          durationMs: performance.now() - started,
          firstTokenMs,
          ...rest,
          errorCode:
            safeCode(facts.errorCode ?? base.errorCode) ?? errorCode(error),
        },
        bound,
      );
    },
  };
}
export function beginEmbeddingRequest(
  opts: CallOptions | undefined,
  op: UsageOperation,
  base: Omit<EmbeddingRequestFacts, 'outcome' | 'durationMs' | 'tokensSource'> &
    Partial<EmbeddingRequestFacts>,
  bound?: IUsageRecorder,
): EmbeddingRequestHandle {
  const started = performance.now();
  let ended = false;
  return {
    firstToken() {},
    end(facts) {
      if (ended) return;
      ended = true;
      const { error, ...rest } = facts;
      reportEmbeddingRequest(
        opts,
        op,
        {
          tokensSource: 'unknown',
          ...base,
          durationMs: performance.now() - started,
          ...rest,
          errorCode:
            safeCode(facts.errorCode ?? base.errorCode) ?? errorCode(error),
        },
        bound,
      );
    },
  };
}
