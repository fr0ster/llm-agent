import {
  type CallOptions,
  type ILlm,
  type IReranker,
  type LlmResponse,
  RagError,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from './assert-positive-integer.js';
import { PASSAGE_QUESTION } from './probability-reranker.js';

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 2;

export interface LlmRerankerOptions {
  /** What "relevant" means for this store. Default: the passage question. */
  question?: { task: string };
  /** Candidates per LLM call; a positive integer. Default 20. */
  batchSize?: number;
  /** Max LLM calls in flight; a positive integer. Default 2. */
  concurrency?: number;
}

function systemPrompt(task: string): string {
  return `You are a relevance scoring engine. Given a query and a numbered list of candidates, score each candidate with the probability (0 to 1) that it satisfies this question: ${task}

Respond with ONLY a JSON array of N numbers between 0 and 1, one per candidate, in the same order, where N is the number of candidates. No other text.
Example for 3 candidates: [0.8, 0.1, 0.95]`;
}

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;

/** Parse the WHOLE reply as a JSON array of `n` numbers in [0, 1]. */
function parseScores(content: string, n: number): number[] | string {
  let text = content.trim();
  const fenced = FENCE.exec(text);
  if (fenced && !fenced[1].includes('```')) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'reply is not a bare JSON array';
  }
  if (!Array.isArray(parsed)) return 'reply is not a JSON array';
  if (parsed.length !== n) {
    return `expected ${n} scores, got ${parsed.length}`;
  }
  for (const x of parsed) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) {
      return 'every score must be a number in [0, 1]';
    }
  }
  return parsed as number[];
}

export class LlmReranker implements IReranker {
  private readonly batchSize: number;
  private readonly concurrency: number;

  /** @throws Error when `batchSize` or `concurrency` is not a positive integer. */
  constructor(
    private readonly llm: ILlm,
    private readonly opts: LlmRerankerOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    assertPositiveInteger('LlmReranker', 'batchSize', this.batchSize);
    assertPositiveInteger('LlmReranker', 'concurrency', this.concurrency);
  }

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (results.length === 0) {
      return { ok: true, value: results };
    }

    const { batchSize, concurrency } = this;
    const batches: Array<{ offset: number; items: RagResult[] }> = [];
    for (let i = 0; i < results.length; i += batchSize) {
      batches.push({ offset: i, items: results.slice(i, i + batchSize) });
    }

    const scores: number[] = new Array(results.length);
    for (let s = 0; s < batches.length; s += concurrency) {
      const slice = batches.slice(s, s + concurrency);
      const outcomes = await Promise.all(
        slice.map((b) => this._scoreBatch(query, b.items, options)),
      );
      for (let k = 0; k < slice.length; k++) {
        const o = outcomes[k];
        if (!o.ok) return o;
        o.value.forEach((v, j) => {
          scores[slice[k].offset + j] = v;
        });
      }
    }

    // Never ok with a missing score: every candidate must have been scored.
    for (let i = 0; i < results.length; i++) {
      const v = scores[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return {
          ok: false,
          error: new RagError(
            `Reranking failed: no score for candidate ${i}`,
            'RERANK_ERROR',
          ),
        };
      }
    }

    const reranked = results
      .map((r, i) => ({ r: { ...r, score: scores[i] }, i }))
      .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
      .map((x) => x.r);
    return { ok: true, value: reranked };
  }

  private async _scoreBatch(
    query: string,
    items: RagResult[],
    options?: CallOptions,
  ): Promise<Result<number[], RagError>> {
    const task = this.opts.question?.task ?? PASSAGE_QUESTION.task;
    const passages = items.map((r, i) => `[${i}] ${r.text}`).join('\n\n');
    const messages = [
      { role: 'system' as const, content: systemPrompt(task) },
      {
        role: 'user' as const,
        content: `Query: ${query}\n\nCandidates (${items.length}):\n${passages}`,
      },
    ];
    const started = Date.now();
    try {
      const res = await this.llm.chat(messages, [], options);
      if (!res.ok) {
        return {
          ok: false,
          error: new RagError(res.error.message, 'RERANK_ERROR'),
        };
      }
      // Meter the call before parsing: an out-of-contract reply is billed too.
      this._logUsage(messages, res.value, started, options);
      const scores = parseScores(res.value.content, items.length);
      if (typeof scores === 'string') {
        return {
          ok: false,
          error: new RagError(`Reranking failed: ${scores}`, 'RERANK_ERROR'),
        };
      }
      return { ok: true, value: scores };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(`Reranking failed: ${String(err)}`, 'RERANK_ERROR'),
      };
    }
  }

  /** Never throws: a failing logger must not turn a good rerank into an error. */
  private _logUsage(
    messages: Array<{ content: string }>,
    reply: LlmResponse,
    started: number,
    options?: CallOptions,
  ): void {
    const logger = options?.requestLogger;
    if (!logger) return;
    try {
      const usage = reply.usage;
      const promptTokens =
        usage?.promptTokens ??
        Math.ceil(messages.map((m) => m.content).join('').length / 4);
      const completionTokens =
        usage?.completionTokens ?? Math.ceil(reply.content.length / 4);
      logger.logLlmCall({
        component: 'rerank',
        model: this.llm.model ?? 'unknown',
        promptTokens,
        completionTokens,
        totalTokens: usage?.totalTokens ?? promptTokens + completionTokens,
        durationMs: Date.now() - started,
        scope: 'request',
        requestId: options?.trace?.traceId,
        ...(usage === undefined ? { estimated: true } : {}),
      });
    } catch {
      // metering is best-effort
    }
  }
}
