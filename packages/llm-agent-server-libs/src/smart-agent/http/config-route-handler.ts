import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ILlm, IModelResolver } from '@mcp-abap-adt/llm-agent';
import type {
  SmartAgent,
  SmartAgentReconfigureOptions,
} from '@mcp-abap-adt/llm-agent-libs';
import { jsonError, readBody } from './response-helpers.js';

/** Exactly the SmartServer state PUT /v1/config touches — the hot-swap seam. */
export interface IConfigUpdateTarget {
  readonly modelResolver?: IModelResolver;
  setMainLlm(llm: ILlm): void;
  setClassifierLlm(llm: ILlm): void;
  setHelperLlm(llm: ILlm): void;
  /** Deep-merge `patch` into the mirrored `cfg.agent` (preserve untouched startup fields). */
  mirrorAgentCfg(patch: Record<string, unknown>): void;
  drainWorkers(): Promise<void>;
  invalidateSessions(): Promise<void>;
}

/** Whitelisted agent config fields allowed via PUT /v1/config. */
const AGENT_CONFIG_FIELDS = new Set([
  'maxIterations',
  'maxToolCalls',
  'ragQueryK',
  'toolUnavailableTtlMs',
  'showReasoning',
  'historyAutoSummarizeLimit',
  'classificationEnabled',
]);

/**
 * PUT /v1/config handler, extracted verbatim from SmartServer._handleConfigUpdate.
 * SmartServer state is reached through `target` (IConfigUpdateTarget): the LLM
 * setters ARE the hot-swap that RoleLlmResolver's live accessors observe.
 */
export async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  smartAgent: SmartAgent,
  target: IConfigUpdateTarget,
): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      jsonError('Request body must be a JSON object', 'invalid_request_error'),
    );
    return;
  }

  const body = parsed as Record<string, unknown>;

  // --- Validate agent fields against whitelist ---
  if (body.agent !== undefined) {
    if (
      typeof body.agent !== 'object' ||
      body.agent === null ||
      Array.isArray(body.agent)
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError('"agent" must be a JSON object', 'invalid_request_error'),
      );
      return;
    }
    const agentFields = body.agent as Record<string, unknown>;
    const unsupported = Object.keys(agentFields).filter(
      (k) => !AGENT_CONFIG_FIELDS.has(k),
    );
    if (unsupported.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          `Unsupported agent config fields: ${unsupported.join(', ')}`,
          'invalid_request_error',
        ),
      );
      return;
    }
  }

  // --- Validate and resolve models (atomic: resolve ALL before mutating) ---
  let resolvedModels: SmartAgentReconfigureOptions | undefined;
  if (body.models !== undefined) {
    if (
      typeof body.models !== 'object' ||
      body.models === null ||
      Array.isArray(body.models)
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError('"models" must be a JSON object', 'invalid_request_error'),
      );
      return;
    }
    if (!target.modelResolver) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError('model resolver not configured', 'invalid_request_error'),
      );
      return;
    }
    const modelFields = body.models as Record<string, unknown>;
    const validKeys = new Set(['mainModel', 'classifierModel', 'helperModel']);
    const unknownKeys = Object.keys(modelFields).filter(
      (k) => !validKeys.has(k),
    );
    if (unknownKeys.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          `Unknown model fields: ${unknownKeys.join(', ')}`,
          'invalid_request_error',
        ),
      );
      return;
    }
    try {
      const resolver = target.modelResolver;
      const [mainLlm, classifierLlm, helperLlm] = await Promise.all([
        modelFields.mainModel
          ? resolver.resolve(String(modelFields.mainModel), 'main')
          : undefined,
        modelFields.classifierModel
          ? resolver.resolve(String(modelFields.classifierModel), 'classifier')
          : undefined,
        modelFields.helperModel
          ? resolver.resolve(String(modelFields.helperModel), 'helper')
          : undefined,
      ]);
      resolvedModels = {};
      if (mainLlm) resolvedModels.mainLlm = mainLlm;
      if (classifierLlm) resolvedModels.classifierLlm = classifierLlm;
      if (helperLlm) resolvedModels.helperLlm = helperLlm;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(jsonError(String(err), 'server_error'));
      return;
    }
  }

  // --- All validation passed — apply mutations ---
  if (resolvedModels) {
    smartAgent.reconfigure(resolvedModels);
    // Mirror onto the hoisted globals consumed by `buildSessionAgent` so
    // freshly-built session graphs pick up the new LLMs by reference
    // (otherwise `this._mainLlm` etc. would keep pointing at the originals
    // captured during `start()`).
    if (resolvedModels.mainLlm) target.setMainLlm(resolvedModels.mainLlm);
    if (resolvedModels.classifierLlm)
      target.setClassifierLlm(resolvedModels.classifierLlm);
    if (resolvedModels.helperLlm) target.setHelperLlm(resolvedModels.helperLlm);
  }
  if (body.agent) {
    const patch = body.agent as Record<string, unknown>;
    smartAgent.applyConfigUpdate(patch);
    // Mirror onto `this.cfg.agent` so freshly-built session graphs (which
    // read `this.cfg.agent` in `buildSessionAgent`) observe the update.
    // Deep-merge to preserve untouched startup fields; replacing the whole
    // `agent` block would drop YAML defaults the validator already applied.
    target.mirrorAgentCfg(patch);
  }
  // Invalidate per-session SmartAgents + the worker-LLM cache so the next
  // request mints a session graph that observes the just-applied config.
  // Without this, chat routes dispatch to `graph.agent` (the per-session
  // SmartAgent) which was built with the OLD config, and the PUT is a
  // no-op from the consumer's perspective. Failures are non-fatal so the
  // 200 response isn't blocked by a dispose hiccup.
  if (resolvedModels || body.agent) {
    // Fix #21: drain per-worker SmartAgentHandle.close() BEFORE clearing the
    // cache so MCP clients owned by the discarded handles disconnect.
    await target.drainWorkers();
    try {
      await target.invalidateSessions();
    } catch {
      // Swallow: cleanup errors must not turn a successful config update
      // into a 500. The next request will still get a fresh build because
      // `_workers.cache` is already cleared and dispose is idempotent.
    }
  }
  // --- Return updated config ---
  const models = smartAgent.getActiveConfig();
  const agent = smartAgent.getAgentConfig();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ models, agent }));
}
