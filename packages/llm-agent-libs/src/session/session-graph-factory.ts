import type {
  ILogger,
  IMcpClient,
  IMcpServer,
  IRag,
  IRagRegistry,
  McpClientDescriptor,
} from '@mcp-abap-adt/llm-agent';
import { collectServerDescriptors } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { stopAll } from '../util/stop-all.js';
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
  /**
   * Per-slot descriptors paired with `mcpClients` (#244), when the session's
   * client set was resolved via `mcpClientFactoryWithDescriptors`. `undefined`
   * when only the legacy `mcpClientFactory` was used — array-index pairing is
   * then the caller's own responsibility (back-compat).
   */
  readonly mcpClientDescriptors?: readonly McpClientDescriptor[];
  /** Total configured `mcp[]` slots, paired with `mcpClientDescriptors` (#244). */
  readonly configuredSlotCount?: number;
  readonly toolsRag: IRag | undefined;
  readonly ragRegistry: IRagRegistry;
  readonly logger: SessionRequestLogger;
}

export interface SessionGraphFactoryOptions {
  /**
   * Servers for THIS caller: the factory starts each one before `buildAgent`,
   * hands the clients over, and stops them last on dispose. Takes the identity,
   * which is what per-caller credentials need and what `mcpClientFactory` never
   * had.
   *
   * When set it takes precedence over `mcpClientFactory` and
   * `mcpClientFactoryWithDescriptors`.
   */
  readonly mcpServerFactory?: (identity: SessionGraphIdentity) => IMcpServer[];
  /**
   * Resolve this session's MCP client(s). Per-session-CAPABLE: the default
   * factory returns the shared GLOBAL client(s) by reference (no re-connect);
   * a creds-aware build (out of scope) returns a fresh per-session client.
   * Either way the tools-catalog RAG is never re-vectorized.
   *
   * @deprecated Use `mcpServerFactory`, which also owns lifetime and receives
   * the identity. Optional since this release: supply exactly one of
   * `mcpServerFactory`, `mcpClientFactoryWithDescriptors` or this.
   */
  readonly mcpClientFactory?: (identity: SessionGraphIdentity) => IMcpClient[];
  /**
   * ADDITIVE descriptor-aware seam (#244): when set, takes precedence over
   * `mcpClientFactory` and pairs the resolved clients with the STABLE
   * `slotIndex`-keyed descriptors they came from (needed to rebind provenance
   * across a FILTERED client set, where array-index pairing breaks — e.g.
   * active slots `[0,2]` collapse to array indices `[0,1]`). `mcpClientFactory`
   * stays required for back-compat; this field is optional and, when absent,
   * `build()` falls back to `mcpClientFactory` (descriptors stay `undefined`).
   *
   * @deprecated Use `mcpServerFactory`, which also owns lifetime and receives
   * the identity. Optional since this release: supply exactly one of
   * `mcpServerFactory`, this or `mcpClientFactory`.
   */
  readonly mcpClientFactoryWithDescriptors?: (
    identity: SessionGraphIdentity,
  ) => {
    clients: IMcpClient[];
    clientDescriptors?: readonly McpClientDescriptor[];
    configuredSlotCount?: number;
  };
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
  /**
   * Per-session teardown that must run BEFORE the session's RAG collections are
   * deleted — closing a pipeline still in flight, which must not write into a
   * collection being removed.
   *
   * `onDispose` keeps its documented place after `closeSession`; this hook is
   * the one that runs first.
   */
  readonly closePipeline?: (sessionId: string) => Promise<void>;
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
    if (
      !this.opts.mcpServerFactory &&
      !this.opts.mcpClientFactoryWithDescriptors &&
      !this.opts.mcpClientFactory
    )
      throw new Error(
        'SessionGraphFactory needs one of mcpServerFactory, mcpClientFactoryWithDescriptors or mcpClientFactory',
      );

    const logger = new SessionRequestLogger();
    const toolAvailability = new ToolAvailabilityRegistry();
    const pendingToolResults = new PendingToolResultsRegistry();

    let mcpClients: IMcpClient[];
    let mcpClientDescriptors: readonly McpClientDescriptor[] | undefined;
    let configuredSlotCount: number | undefined;
    const startedServers: IMcpServer[] = [];
    if (this.opts.mcpServerFactory) {
      const servers = this.opts.mcpServerFactory(identity);
      // All or none — see the builder's identical check and why it throws.
      const descriptors = collectServerDescriptors(servers, 'mcpServerFactory');

      const clients: IMcpClient[] = [];
      try {
        for (const server of servers) {
          clients.push(await server.start());
          startedServers.push(server);
        }
      } catch (err) {
        await stopAll(
          startedServers.splice(0).map((server) => () => server.stop()),
        );
        throw err;
      }
      mcpClients = clients;
      mcpClientDescriptors = descriptors;
      // Nothing was filtered out of a configured set, so there is no original
      // count to preserve; array position is the pairing.
      configuredSlotCount = undefined;
    } else if (this.opts.mcpClientFactoryWithDescriptors) {
      const built = this.opts.mcpClientFactoryWithDescriptors(identity);
      mcpClients = built.clients;
      mcpClientDescriptors = built.clientDescriptors;
      configuredSlotCount = built.configuredSlotCount;
    } else {
      // The guard at the top of build() has already ruled out "none set".
      mcpClients = this.opts.mcpClientFactory?.(identity) ?? [];
    }
    // `buildAgent` runs a full `SmartAgentBuilder.build()` — model validation,
    // network work — and can throw. When it does, no `SessionGraph` is
    // constructed, so `dispose()` never runs and `startedServers` becomes
    // unreachable: stop them here, on the ORIGINAL failure, before rethrowing.
    let agent: SmartAgent | undefined;
    let graph: SessionGraph;
    try {
      agent = await this.opts.buildAgent({
        sessionId: identity.sessionId,
        mcpClients,
        mcpClientDescriptors,
        configuredSlotCount,
        toolsRag: this.opts.toolsRag,
        ragRegistry: this.opts.ragRegistry,
        logger,
      });

      graph = new SessionGraph({
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
          // Single sink for every best-effort teardown failure below: routes to
          // the configured logger, or console.warn when there is none. Each call
          // site's two message strings are unchanged from before this helper
          // existed — the teardown tests assert on them.
          const warn = (logMessage: string, consoleMessage: string) => {
            if (this.opts.logger) {
              this.opts.logger.log({
                type: 'warning',
                traceId: `session:${sessionId}`,
                message: logMessage,
              });
            } else {
              console.warn(consoleMessage);
            }
          };

          // Runs first: a pipeline still in flight must not write into a session
          // collection that `closeSession` is about to delete. Best-effort, like
          // every other step here.
          if (this.opts.closePipeline) {
            try {
              await this.opts.closePipeline(sessionId);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              warn(
                `session_close_pipeline_failed: ${message}`,
                `[session] closePipeline(${sessionId}) failed: ${message}`,
              );
            }
          }
          // Best-effort like every other step here: a REJECTING closeSession
          // must not skip onDispose/stop below it, exactly like a resolved
          // `{ ok: false }` result must not (handled right underneath). Both
          // cases route through the same two message strings — unchanged —
          // since the pre-existing teardown tests assert on them.
          try {
            const res = await this.opts.ragRegistry.closeSession(sessionId);
            if (!res.ok) {
              const message = res.error?.message ?? String(res.error);
              warn(
                `session_close_failed: ${message}`,
                `[session] closeSession(${sessionId}) failed: ${message}`,
              );
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            warn(
              `session_close_failed: ${message}`,
              `[session] closeSession(${sessionId}) failed: ${message}`,
            );
          }
          // Host-supplied per-session teardown (e.g. pipeline IPipelineInstance.close).
          // Best-effort: a failure here must not crash session disposal.
          if (this.opts.onDispose) {
            try {
              await this.opts.onDispose(sessionId);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              warn(
                `session_dispose_hook_failed: ${message}`,
                `[session] onDispose(${sessionId}) failed: ${message}`,
              );
            }
          }
          // Last: the clients outlive the pipeline that was still calling them.
          for (const server of startedServers) {
            try {
              await server.stop();
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              warn(
                `session_mcp_stop_failed: ${message}`,
                `[session] mcp stop(${sessionId}) failed: ${message}`,
              );
            }
          }
        },
      });
    } catch (err) {
      // `buildAgent` (or, in principle, the `SessionGraph` construction above)
      // threw before a `SessionGraph` exists to own teardown — nothing else
      // will ever stop these servers. Stop them here, on the ORIGINAL error.
      await stopAll(startedServers.map((server) => () => server.stop()));
      throw err;
    }

    return graph;
  }
}
