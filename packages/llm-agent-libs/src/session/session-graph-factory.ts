import type {
  ILogger,
  IMcpClient,
  IRag,
  IRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { SessionGraph } from './session-graph.js';

export interface SessionGraphIdentity {
  readonly sessionId: string;
  readonly userId?: string;
}

/**
 * Parts handed to `buildAgent` — the injected globals + per-session services.
 * The server's buildAgent uses these to assemble a FRESH per-session agent AND
 * a fresh per-session worker set (each worker re-wired via the inject-globals
 * path with this session's logger + the cached per-worker LLM/embedder).
 */
export interface SessionAgentParts {
  readonly sessionId: string;
  readonly mcpClients: IMcpClient[];
  readonly toolsRag: IRag | undefined;
  readonly ragRegistry: IRagRegistry;
  readonly logger: SessionRequestLogger;
}

export interface SessionGraphFactoryOptions {
  /**
   * Resolve this session's MCP client(s). Per-session-CAPABLE: the default
   * factory returns the shared GLOBAL client(s) by reference (no re-connect);
   * a creds-aware build (out of scope) returns a fresh per-session client.
   * Either way the tools-catalog RAG is never re-vectorized.
   */
  readonly mcpClientFactory: (identity: SessionGraphIdentity) => IMcpClient[];
  /** GLOBAL vectorized tools-catalog RAG — injected by reference, never re-vectorized. */
  readonly toolsRag: IRag | undefined;
  /** GLOBAL RAG provider/registry — shared; the per-call scope filter isolates. */
  readonly ragRegistry: IRagRegistry;
  /**
   * Builds the per-session SmartAgent + FRESH per-session workers from `parts`.
   * Production wiring runs a `SmartAgentBuilder.build()` with the injected globals
   * + this session's logger AND re-wires the subagent registry/DAG deps per session
   * (Task A10), reusing the cached per-worker LLM/embedder (Task A7). Tests inject
   * a stub. Returns the built agent (or undefined in pure-wiring tests).
   */
  readonly buildAgent: (
    parts: SessionAgentParts,
  ) => Promise<SmartAgent | undefined>;
  /**
   * Optional logger used to SURFACE per-session cleanup failures
   * (`ragRegistry.closeSession` returning `{ ok: false }`). Without a logger
   * the failure falls back to `console.warn` so it is never silent. The
   * dispose hook never throws — a failed close must not crash session teardown.
   */
  readonly logger?: ILogger;
  /**
   * Optional per-session teardown hook run during `SessionGraph.dispose()`,
   * AFTER the session-RAG `closeSession`. The host uses this to free per-session
   * pipeline resources (e.g. the pipeline plugin's `IPipelineInstance.close()` —
   * MCP connections / builder-owned handles) that the agent itself does not own.
   * Best-effort: a throw is swallowed (surfaced via `logger`) so teardown never
   * crashes the registry.
   */
  readonly onDispose?: (sessionId: string) => Promise<void>;
}

/**
 * Central per-session composition path (spec A.2). Assembles a SessionGraph by
 * injecting the GLOBAL heavy resources (vectorized toolsRag, RAG registry,
 * cached per-worker LLM/embedder) by reference — never re-vectorizing tools or
 * rebuilding LLM clients — resolving this session's MCP client(s) via
 * `mcpClientFactory(identity)` (default: shared global by reference), and
 * allocating the cheap per-session instances (logger + sessionId-keyed
 * registries + the per-session agent/pipeline/interpreter/coordinator/WORKERS).
 * The per-session worker set is FRESH per session (re-wired via buildAgent
 * with the session logger), never the server's global worker map.
 */
export class SessionGraphFactory {
  constructor(private readonly opts: SessionGraphFactoryOptions) {}

  async build(identity: SessionGraphIdentity): Promise<SessionGraph> {
    const logger = new SessionRequestLogger();
    const toolAvailability = new ToolAvailabilityRegistry();
    const pendingToolResults = new PendingToolResultsRegistry();

    const mcpClients = this.opts.mcpClientFactory(identity);
    const agent = await this.opts.buildAgent({
      sessionId: identity.sessionId,
      mcpClients,
      toolsRag: this.opts.toolsRag,
      ragRegistry: this.opts.ragRegistry,
      logger,
    });

    return new SessionGraph({
      sessionId: identity.sessionId,
      toolAvailability,
      pendingToolResults,
      logger,
      agent,
      // Reuse the EXISTING registry teardown — closes scope:session collections
      // for this sessionId; global/user collections survive (spec A.4). The
      // Result<void, RagError> is INSPECTED here — a failed close is surfaced
      // via the optional logger (or console.warn fallback), never silently
      // dropped (review MEDIUM #2).
      dispose: async (sessionId) => {
        const res = await this.opts.ragRegistry.closeSession(sessionId);
        if (!res.ok) {
          const message = res.error?.message ?? String(res.error);
          if (this.opts.logger) {
            this.opts.logger.log({
              type: 'warning',
              traceId: `session:${sessionId}`,
              message: `session_close_failed: ${message}`,
            });
          } else {
            console.warn(
              `[session] closeSession(${sessionId}) failed: ${message}`,
            );
          }
        }
        // Host-supplied per-session teardown (e.g. pipeline IPipelineInstance.close).
        // Best-effort: a failure here must not crash session disposal.
        if (this.opts.onDispose) {
          try {
            await this.opts.onDispose(sessionId);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (this.opts.logger) {
              this.opts.logger.log({
                type: 'warning',
                traceId: `session:${sessionId}`,
                message: `session_dispose_hook_failed: ${message}`,
              });
            } else {
              console.warn(
                `[session] onDispose(${sessionId}) failed: ${message}`,
              );
            }
          }
        }
      },
    });
  }
}
