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
  try {
    const firstStore = Object.values(ragStores)[0];
    const ragRes = firstStore
      ? await firstStore.healthCheck(options)
      : { ok: true as const, value: undefined };
    results.rag = ragRes.ok;
  } catch {
    results.rag = false;
  }
  try {
    const mcpChecks = await Promise.all(
      activeClients.map(async (client) => {
        try {
          if (client.healthCheck) {
            const hc = await client.healthCheck(options);
            return {
              name: 'mcp-client',
              ok: hc.ok,
              error:
                hc.ok || !hc.error
                  ? undefined
                  : hc.error instanceof Error
                    ? hc.error.message
                    : String(hc.error),
            };
          }
          // Fallback for IMcpClient implementations without healthCheck
          const tools = await client.listTools(options);
          return {
            name: 'mcp-client',
            ok: tools.ok,
            error:
              tools.ok || !tools.error
                ? undefined
                : tools.error instanceof Error
                  ? tools.error.message
                  : String(tools.error),
          };
        } catch (err) {
          return {
            name: 'mcp-client',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.mcp = mcpChecks;
  } catch {
    // AbortSignal timeout — leave mcp as empty
  }
  return results;
};
