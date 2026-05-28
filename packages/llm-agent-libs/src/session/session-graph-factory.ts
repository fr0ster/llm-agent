import type { IMcpClient, IRag, IRagRegistry } from '@mcp-abap-adt/llm-agent';
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
      // for this sessionId; global/user collections survive (spec A.4).
      dispose: async (sessionId) => {
        await this.opts.ragRegistry.closeSession(sessionId);
      },
    });
  }
}
