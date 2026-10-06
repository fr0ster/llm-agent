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
  try {
    if (mainLlm.healthCheck) {
      const hc = await mainLlm.healthCheck(options);
      results.llm = hc.ok && hc.value;
      if (!results.llm) {
        options?.sessionLogger?.logStep('health_llm_probe_error', {
          reason: hc.ok ? 'unhealthy' : String(hc.error?.message ?? hc.error),
        });
      }
    } else {
      // Fallback for ILlm implementations without healthCheck
      const llmRes = await mainLlm.chat(
        [{ role: 'user' as const, content: 'ping' }],
        [],
        options,
      );
      results.llm = llmRes.ok;
      if (!llmRes.ok) {
        options?.sessionLogger?.logStep('health_llm_probe_error', {
          reason: String(llmRes.error?.message ?? llmRes.error),
        });
      }
    }
  } catch (err) {
    results.llm = false;
    options?.sessionLogger?.logStep('health_llm_probe_error', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // H2 (D72): every registered store is probed; `rag` is true only when all
  // answer. No store ⇒ true (absent by design). A probe is a Result-returning
  // call that can also reject — both are a store not working.
  const stores = Object.entries(ragStores);
  const ragProbes = await Promise.allSettled(
    // async: a probe that throws synchronously is a rejection too.
    stores.map(async ([, store]) =>
      untilAborted(store.healthCheck(options), options?.signal),
    ),
  );
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

  // H3, H4 (D72): every client is reported. `{ ok: true, value: false }` is
  // not OK; a probe that rejects, or does not answer before the health signal
  // fires, is reported `ok: false` with the error — never dropped.
  const mcpProbes = await Promise.allSettled(
    activeClients.map((client) =>
      untilAborted(probeMcpClient(client, options), options?.signal),
    ),
  );
  results.mcp = mcpProbes.map((probe) =>
    probe.status === 'fulfilled'
      ? probe.value
      : { name: 'mcp-client', ok: false, error: errorText(probe.reason) },
  );
  return results;
};

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
 * `probe`, or a rejection with the signal's reason once `signal` fires — a
 * probe that ignores the signal must not hold the whole health check.
 */
function untilAborted<T>(probe: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return probe;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    probe.then(
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
