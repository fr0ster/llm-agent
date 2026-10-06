import type {
  CallOptions,
  ILlm,
  IMcpClient,
  IRag,
} from '@mcp-abap-adt/llm-agent';

export interface AgentHealthSnapshot {
  llm: boolean;
  rag: boolean;
  mcp: { name: string; ok: boolean; error?: string }[];
}

export type IAgentHealthProbe = (
  mainLlm: ILlm,
  ragStores: Record<string, IRag>,
  activeClients: IMcpClient[],
  options: CallOptions,
) => Promise<AgentHealthSnapshot>;

export const buildAgentHealthSnapshot: IAgentHealthProbe = async (
  mainLlm,
  ragStores,
  activeClients,
  options,
) => {
  const results: AgentHealthSnapshot = { llm: false, rag: false, mcp: [] };
  const signal = options?.signal;
  const stores = Object.entries(ragStores);

  // The LLM, every store and every client are probed concurrently; each probe
  // is raced against the health signal, so one that ignores it cannot hold
  // the whole check (D72).
  const [llmProbe, ragProbes, mcpProbes] = await Promise.all([
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
  return results;
};

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
