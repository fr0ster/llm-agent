import {
  type CallOptions,
  type ILlm,
  type IMcpClient,
  type IRag,
  type IReranker,
  type IRetrievalStrategy,
  isRagDecorator,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import { strategyOf } from '../retrieval/strategy-rag.js';

export interface AgentHealthSnapshot {
  llm: boolean;
  rag: boolean;
  mcp: { name: string; ok: boolean; error?: string }[];
  /** Every reranker the agent uses, named by its holders (D97). Absent when none. */
  reranker?: { name: string; ok: boolean; error?: string }[];
}

/** A reranker the agent uses, and who holds it (`global`, `store:<key>`). */
export interface HeldReranker {
  name: string;
  reranker: IReranker;
}

export type IAgentHealthProbe = (
  mainLlm: ILlm,
  ragStores: Record<string, IRag>,
  activeClients: IMcpClient[],
  options: CallOptions,
  rerankers?: readonly HeldReranker[],
) => Promise<AgentHealthSnapshot>;

/**
 * The reranker a retrieval strategy holds, read structurally: a `reranker`
 * property with a `rerank` method — `RerankedRetrieval`, `RerankAllRetrieval`
 * and `StagedRetrieval` expose theirs read-only (spec §17.43 D97), and so may a
 * consumer's strategy. No `instanceof`: a second copy of libs is found too.
 */
function rerankerOf(strategy: IRetrievalStrategy): IReranker | undefined {
  const r = (strategy as { reranker?: unknown }).reranker;
  return typeof r === 'object' &&
    r !== null &&
    typeof (r as IReranker).rerank === 'function'
    ? (r as IReranker)
    : undefined;
}

/**
 * Every reranker the agent uses (spec §17.43 D97): the global one, when the
 * agent was given one, and each one a store's retrieval strategy holds — found
 * through the store's decorators. One instance held twice is listed once,
 * naming both holders. A reranker wired into nothing is not here.
 */
export function heldRerankers(
  globalReranker: IReranker | undefined,
  ragStores: Record<string, IRag>,
): HeldReranker[] {
  const holders = new Map<IReranker, string[]>();
  const hold = (r: IReranker, holder: string) => {
    const names = holders.get(r);
    if (names) {
      if (!names.includes(holder)) names.push(holder);
    } else holders.set(r, [holder]);
  };
  if (globalReranker) hold(globalReranker, 'global');
  for (const [key, store] of Object.entries(ragStores)) {
    let cur: IRag | undefined = store;
    for (let depth = 0; cur && depth < 16; depth++) {
      const strategy = strategyOf(cur);
      if (strategy) {
        const r = rerankerOf(strategy);
        if (r) hold(r, `store:${key}`);
      }
      cur = isRagDecorator(cur) ? cur.inner : undefined;
    }
  }
  return [...holders].map(([reranker, names]) => ({
    name: names.join(', '),
    reranker,
  }));
}

export const buildAgentHealthSnapshot: IAgentHealthProbe = async (
  mainLlm,
  ragStores,
  activeClients,
  options,
  rerankers = [],
) => {
  const results: AgentHealthSnapshot = { llm: false, rag: false, mcp: [] };
  const signal = options?.signal;
  const stores = Object.entries(ragStores);

  // The LLM, every store and every client are probed concurrently; each probe
  // is raced against the health signal, so one that ignores it cannot hold
  // the whole check (D72).
  const [llmProbe, ragProbes, mcpProbes, rerankProbes] = await Promise.all([
    untilAborted(() => probeLlm(mainLlm, options), signal).then(
      (reason) => reason,
      (err: unknown) => errorText(err),
    ),
    // H2 (D72): every registered store is probed; `rag` is true only when all
    // answer. No store ⇒ true (absent by design). A probe is a
    // Result-returning call that can also reject — both are a store not
    // working.
    Promise.allSettled(
      stores.map(([, store]) =>
        untilAborted(() => store.healthCheck(options), signal),
      ),
    ),
    // H3, H4 (D72): every client is reported. `{ ok: true, value: false }` is
    // not OK; a probe that rejects, or does not answer before the health
    // signal fires, is reported `ok: false` with the error — never dropped.
    Promise.allSettled(
      activeClients.map((client) =>
        untilAborted(() => probeMcpClient(client, options), signal),
      ),
    ),
    // D97: every reranker the agent uses — `false`, `ok: false`, a rejection
    // or no answer before the health signal is not OK, named by its holders.
    Promise.allSettled(
      rerankers.map((held) =>
        untilAborted(
          () => probeReranker(held.reranker, rerankerOptions(options)),
          signal,
        ),
      ),
    ),
  ]);

  // `probeLlm` resolves `undefined` when the LLM works, else the reason.
  results.llm = llmProbe === undefined;
  if (!results.llm) {
    options?.sessionLogger?.logStep('health_llm_probe_error', {
      reason: llmProbe,
    });
  }

  results.rag = true;
  ragProbes.forEach((probe, i) => {
    const ok = probe.status === 'fulfilled' && probe.value.ok;
    if (ok) return;
    results.rag = false;
    options?.sessionLogger?.logStep('health_rag_probe_error', {
      store: stores[i][0],
      reason:
        probe.status === 'rejected'
          ? errorText(probe.reason)
          : probe.value.ok
            ? 'unhealthy'
            : errorText(probe.value.error),
    });
  });

  results.mcp = mcpProbes.map((probe) =>
    probe.status === 'fulfilled'
      ? probe.value
      : { name: 'mcp-client', ok: false, error: errorText(probe.reason) },
  );
  if (rerankers.length > 0) {
    results.reranker = rerankProbes.map((probe, i) => {
      const name = rerankers[i].name;
      const reason =
        probe.status === 'fulfilled' ? probe.value : errorText(probe.reason);
      return reason === undefined
        ? { name, ok: true }
        : { name, ok: false, error: reason };
    });
  }
  return results;
};

/**
 * What a reranker probe passes on: the signal and the tracing/logging context,
 * never the probe's `maxTokens: 1` — a fallback minimal rerank is a real model
 * call whose reply must not be cut to one token.
 */
function rerankerOptions(options: CallOptions): CallOptions {
  const out: CallOptions = {};
  if (options.signal) out.signal = options.signal;
  if (options.sessionLogger) out.sessionLogger = options.sessionLogger;
  if (options.requestLogger) out.requestLogger = options.requestLogger;
  if (options.trace) out.trace = options.trace;
  return out;
}

/**
 * The one short candidate a minimal health rerank scores. The same probe lives
 * in `@mcp-abap-adt/llm-agent-reranker` `src/health.ts` (`minimalRerank`), used
 * by the shipped rerankers' own `healthCheck`; keep the two alike.
 */
const HEALTH_CANDIDATE: RagResult = {
  text: 'health check',
  metadata: { id: 'health' },
  score: 1,
};

/** `undefined` when the reranker works, else why not (D97). */
async function probeReranker(
  reranker: IReranker,
  options: CallOptions,
): Promise<string | undefined> {
  if (reranker.healthCheck) {
    const hc = await reranker.healthCheck(options);
    if (hc.ok) return hc.value ? undefined : 'unhealthy';
    return errorText(hc.error);
  }
  // A reranker without healthCheck: one minimal rerank over one candidate.
  const r = await reranker.rerank('health check', [HEALTH_CANDIDATE], options);
  return r.ok ? undefined : errorText(r.error);
}

/** `undefined` when the LLM works, else why not. */
async function probeLlm(
  mainLlm: ILlm,
  options: CallOptions,
): Promise<string | undefined> {
  if (mainLlm.healthCheck) {
    const hc = await mainLlm.healthCheck(options);
    if (hc.ok && hc.value) return undefined;
    return hc.ok ? 'unhealthy' : String(hc.error?.message ?? hc.error);
  }
  // An ILlm without healthCheck: a one-token chat is the probe.
  const llmRes = await mainLlm.chat(
    [{ role: 'user' as const, content: 'ping' }],
    [],
    options,
  );
  return llmRes.ok ? undefined : String(llmRes.error?.message ?? llmRes.error);
}

async function probeMcpClient(
  client: IMcpClient,
  options: CallOptions,
): Promise<{ name: string; ok: boolean; error?: string }> {
  if (client.healthCheck) {
    const hc = await client.healthCheck(options);
    if (hc.ok) {
      return hc.value
        ? { name: 'mcp-client', ok: true }
        : { name: 'mcp-client', ok: false, error: 'unhealthy' };
    }
    return { name: 'mcp-client', ok: false, error: errorText(hc.error) };
  }
  // An IMcpClient without healthCheck: listing its tools is the probe.
  const tools = await client.listTools(options);
  return tools.ok
    ? { name: 'mcp-client', ok: true }
    : { name: 'mcp-client', ok: false, error: errorText(tools.error) };
}

/**
 * Start `probe` and settle with it, or reject with the signal's reason once
 * `signal` fires — a probe that ignores the signal must not hold the whole
 * health check. Under an already-aborted signal the probe is never started.
 * A synchronous throw from `probe` is a rejection. A probe left running after
 * the abort keeps its handlers, so its late rejection is never unhandled.
 */
function untilAborted<T>(
  probe: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let started: Promise<T>;
  try {
    started = probe();
  } catch (err) {
    return Promise.reject(err);
  }
  if (!signal) return started;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    started.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (reason) => {
        signal.removeEventListener('abort', onAbort);
        reject(reason);
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
