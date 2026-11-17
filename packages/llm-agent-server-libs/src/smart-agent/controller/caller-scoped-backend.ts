import { createHash, randomUUID } from 'node:crypto';
import type { CallOptions } from '@mcp-abap-adt/llm-agent';
import {
  callerIdentityKey,
  type KnowledgeBackend,
  resolveCaller,
} from '@mcp-abap-adt/llm-agent-libs';

/** Scope every durable controller artifact, including bundles and terminal replay. */
export function controllerStorageKey(
  options: CallOptions | undefined,
  sessionId: string,
): string | undefined {
  const key = callerIdentityKey(resolveCaller(options, sessionId));
  return key === undefined
    ? undefined
    : `controller-${createHash('sha256').update(key).digest('hex')}`;
}

export function callerScopedBackend(
  backend: KnowledgeBackend,
  options: CallOptions | undefined,
  sessionId: string,
): { backend: KnowledgeBackend; storageKey: string } {
  // Anonymous work has a fresh namespace per invocation and can never resume.
  const storageKey = controllerStorageKey(options, sessionId) ?? randomUUID();
  // Legacy bare-sessionId bundles have no stored owner. Never read or migrate
  // them: knowing a sessionId cannot prove ownership. Leave them untouched;
  // clients must restart runs suspended before caller-scoped storage.
  return {
    storageKey,
    backend: {
      semanticRecallCapable: backend.semanticRecallCapable,
      put: (_sessionId, entry, callOptions) =>
        backend.put(storageKey, entry, callOptions),
      semanticQuery: (_sessionId, text, k, filter, callOptions) =>
        backend.semanticQuery(storageKey, text, k, filter, callOptions),
      scan: () => backend.scan(storageKey),
      deleteSession: () => backend.deleteSession(storageKey),
    },
  };
}
