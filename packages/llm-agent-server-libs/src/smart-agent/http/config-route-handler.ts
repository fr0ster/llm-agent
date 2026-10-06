import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ILlm, IModelResolver } from '@mcp-abap-adt/llm-agent';
import type {
  SmartAgent,
  SmartAgentReconfigureOptions,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  type AgentUpdate,
  ConfigFieldError,
  checkNoValue,
  FieldCheck,
  MODEL_FIELDS,
  type ModelUpdate,
  UPDATABLE_AGENT_FIELDS,
  validateAgentUpdate,
  validateModelUpdate,
} from '../config-fields.js';
import {
  ConfigChangeRefusedError,
  type IConfigTransactionQueue,
} from '../config-transaction-queue.js';
import { jsonError, readBody } from './response-helpers.js';

/** Exactly the SmartServer state PUT /v1/config touches — the hot-swap seam. */
export interface IConfigUpdateTarget {
  readonly modelResolver?: IModelResolver;
  /** The switch startup's model check obeys; a swapped-in model is checked the same way. */
  readonly skipModelValidation: boolean;
  /** Each setter holds `llm` for its role and returns the instance now held —
   *  the server may guard it (its per-key circuit breaker), and that guarded
   *  instance is what every agent must use. */
  setMainLlm(llm: ILlm): ILlm;
  setClassifierLlm(llm: ILlm): ILlm;
  setHelperLlm(llm: ILlm): ILlm;
  /** Deep-merge `patch` into the mirrored `cfg.agent` (preserve untouched startup fields). */
  mirrorAgentCfg(patch: Record<string, unknown>): void;
  drainWorkers(): Promise<void>;
  invalidateSessions(): Promise<void>;
  /** The server's one config queue (spec V10, D80, D82) — the instance the reload watcher uses; it holds the not-ready state. */
  readonly transactions: IConfigTransactionQueue;
}

/** Whitelisted agent config fields allowed via PUT /v1/config — each has its rule (spec V10, D83). */
const AGENT_CONFIG_FIELDS = new Set<string>(UPDATABLE_AGENT_FIELDS);

/**
 * The top-level sections PUT /v1/config can change on this server — its whole
 * config (spec §10.5.9 V10, D82 (8)): `agent` always, `models` only with a model
 * resolver (without one the route answers 400 to `models`). The route reads
 * no other section.
 */
function configSections(target: IConfigUpdateTarget): readonly string[] {
  return target.modelResolver ? ['models', 'agent'] : ['agent'];
}

/** The sections `body` does not carry: absent, or an empty object (it changes nothing). */
function missingSections(
  body: Record<string, unknown>,
  target: IConfigUpdateTarget,
): string[] {
  return configSections(target).filter((k) => {
    const v = body[k];
    return (
      v === undefined ||
      (typeof v === 'object' &&
        v !== null &&
        !Array.isArray(v) &&
        Object.keys(v).length === 0)
    );
  });
}

/**
 * 409 — the request conflicts with the server's state, it is not malformed
 * (spec D82 (8)): while a config change has not applied, only the whole
 * config is accepted. Nothing was resolved, applied or queued.
 */
function writeConfigIncomplete(
  res: ServerResponse,
  missing: readonly string[],
): void {
  res.writeHead(409, { 'Content-Type': 'application/json' });
  res.end(
    jsonError(
      `server not ready — send the whole config: ${missing.join(', ')}`,
      'invalid_request_error',
      'config_not_applied',
    ),
  );
}

/**
 * 400 — a field value the config field validator refused (spec V10, D83):
 * the reload's rules, every invalid field named, before anything is resolved,
 * applied or queued. Any other throw is not a validation result: rethrown.
 */
function writeInvalidFields(res: ServerResponse, err: unknown): void {
  if (!(err instanceof ConfigFieldError)) throw err;
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(jsonError(err.message, 'invalid_request_error'));
}

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

  // --- While the server is not ready, only the whole config clears it (spec V10, D82 (8)) ---
  const missing = missingSections(body, target);
  if (missing.length > 0 && target.transactions.notApplied) {
    writeConfigIncomplete(res, missing);
    return;
  }

  // --- A key with no value is an error (spec V10, D83 (13)) ---
  // `"agent": null` was `"agent" must be a JSON object`; a null field failed
  // its rule. Now one message, before any section is read: nothing resolved,
  // applied or queued.
  const noValue = new FieldCheck();
  checkNoValue(noValue, body);
  try {
    noValue.done(undefined);
  } catch (err) {
    writeInvalidFields(res, err);
    return;
  }

  // --- Validate agent fields against whitelist ---
  let agentUpdate: AgentUpdate | undefined;
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
    try {
      agentUpdate = validateAgentUpdate(agentFields);
    } catch (err) {
      writeInvalidFields(res, err);
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
    const validKeys = new Set<string>(MODEL_FIELDS);
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
    let modelUpdate: ModelUpdate;
    try {
      modelUpdate = validateModelUpdate(modelFields);
    } catch (err) {
      writeInvalidFields(res, err);
      return;
    }
    try {
      const resolver = target.modelResolver;
      const [mainLlm, classifierLlm, helperLlm] = await Promise.all([
        modelUpdate.mainModel !== undefined
          ? resolver.resolve(modelUpdate.mainModel, 'main')
          : undefined,
        modelUpdate.classifierModel !== undefined
          ? resolver.resolve(modelUpdate.classifierModel, 'classifier')
          : undefined,
        modelUpdate.helperModel !== undefined
          ? resolver.resolve(modelUpdate.helperModel, 'helper')
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
    // A resolver only constructs: a wrong model name first fails on a call.
    // Ask each new model once, as startup does, BEFORE anything is applied —
    // otherwise the swap succeeds and every later request fails.
    if (!target.skipModelValidation) {
      const checks: [string, ILlm | undefined][] = [
        [String(modelUpdate.mainModel), resolvedModels.mainLlm],
        [String(modelUpdate.classifierModel), resolvedModels.classifierLlm],
        [String(modelUpdate.helperModel), resolvedModels.helperLlm],
      ];
      for (const [name, llm] of checks) {
        if (!llm) continue;
        const probe = await llm.chat(
          [{ role: 'user', content: 'Reply with OK' }],
          undefined,
          { maxTokens: 10 },
        );
        if (!probe.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            jsonError(
              `model "${name}" is not available: ${probe.error.message}`,
              'invalid_request_error',
            ),
          );
          return;
        }
      }
    }
  }

  // --- All validation passed (spec §10.5.9 V10, D80, D82) ---
  // The validated values (D83) — never the body's raw ones.
  const patch = agentUpdate;
  if (!resolvedModels && !patch) {
    // Nothing to change: not a config change, so it neither waits for the
    // queue nor clears the server's not-ready state. Reached only while the
    // server is ready — while it is not, such a PUT misses every section
    // and was refused above (D82 (8)).
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        models: smartAgent.getActiveConfig(),
        agent: smartAgent.getAgentConfig(),
      }),
    );
    return;
  }
  let applied: ConfigTransactionResult;
  try {
    // One transaction in the server's config queue: it starts only after the
    // previous config change (a PUT or a file reload) settled.
    applied = await target.transactions.run(
      'put',
      missing.length === 0 ? 'full' : 'partial',
      () => applyConfigTransaction(resolvedModels, patch, smartAgent, target),
    );
  } catch (err) {
    if (err instanceof ConfigChangeRefusedError) {
      // D82 (8): passed the check above while the server was ready, but a
      // transaction ahead of it failed — refused at its start, nothing applied.
      writeConfigIncomplete(res, missing);
      return;
    }
    // The queue has marked the server not ready (D82). A server-side
    // failure: the status and type of this route's model resolver failure
    // and of the server's catch-all.
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      jsonError(
        err instanceof Error ? err.message : String(err),
        'server_error',
      ),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(applied));
}

type ConfigTransactionResult = {
  models: ReturnType<SmartAgent['getActiveConfig']>;
  agent: ReturnType<SmartAgent['getAgentConfig']>;
};

const UPDATE_FAILED =
  'config update failed, the server is not ready until a whole config applies';

/**
 * One PUT /v1/config transaction (spec §10.5.9 V10, D80, D82). Run only by
 * the server's config queue. Applies in 30.1.0's order — the held LLMs, the
 * startup agent (`reconfigure`, then `applyConfigUpdate`), the server's
 * mirror — then drains the workers and invalidates the sessions (both run,
 * one verdict). Any failure rejects, naming every failed step; nothing is
 * restored (no rollback): the server is not ready until a whole config
 * applies.
 */
async function applyConfigTransaction(
  resolvedModels: SmartAgentReconfigureOptions | undefined,
  patch: AgentUpdate | undefined,
  smartAgent: SmartAgent,
  target: IConfigUpdateTarget,
): Promise<ConfigTransactionResult> {
  try {
    if (resolvedModels) {
      // Mirror onto the hoisted globals consumed by `buildSessionAgent` so
      // freshly-built session graphs pick up the new LLMs by reference. The
      // setters return the instance now held (breaker-guarded when
      // configured); the startup agent gets that same one.
      const held: SmartAgentReconfigureOptions = {};
      if (resolvedModels.mainLlm)
        held.mainLlm = target.setMainLlm(resolvedModels.mainLlm);
      if (resolvedModels.classifierLlm) {
        held.classifierLlm = target.setClassifierLlm(
          resolvedModels.classifierLlm,
        );
      }
      if (resolvedModels.helperLlm)
        held.helperLlm = target.setHelperLlm(resolvedModels.helperLlm);
      smartAgent.reconfigure(held);
    }
    if (patch) {
      smartAgent.applyConfigUpdate(patch);
      // Deep-merge onto `cfg.agent`: freshly-built session graphs read it.
      target.mirrorAgentCfg(patch);
    }
  } catch (err) {
    throw new Error(`${UPDATE_FAILED} — apply: ${String(err)}`, {
      cause: err,
    });
  }
  // Fix #21: drain the per-worker handles BEFORE the sessions are
  // invalidated. Both run (each settles), then one verdict (spec V6, V10).
  const failures: string[] = [];
  let cause: unknown;
  try {
    await target.drainWorkers();
  } catch (err) {
    failures.push(`worker drain: ${String(err)}`);
    cause = err;
  }
  try {
    await target.invalidateSessions();
  } catch (err) {
    failures.push(`session invalidation: ${String(err)}`);
    cause ??= err;
  }
  if (failures.length > 0) {
    throw new Error(`${UPDATE_FAILED} — ${failures.join('; ')}`, { cause });
  }
  return {
    models: smartAgent.getActiveConfig(),
    agent: smartAgent.getAgentConfig(),
  };
}
