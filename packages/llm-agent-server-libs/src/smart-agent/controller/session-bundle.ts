import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import type { SessionBundle } from './types.js';

const BUNDLE_ARTIFACT_TYPE = 'controller-bundle';

const EMPTY_BUNDLE: SessionBundle = {
  goal: '',
  plannerPrivate: '',
  budgets: { stepsUsed: 0, rewindsUsed: 0 },
};

function emptyBundle(): SessionBundle {
  return {
    goal: EMPTY_BUNDLE.goal,
    plannerPrivate: EMPTY_BUNDLE.plannerPrivate,
    budgets: { ...EMPTY_BUNDLE.budgets },
  };
}

/**
 * Durably persist the session bundle into the KnowledgeBackend, keyed by
 * sessionId. Uses artifactType 'controller-bundle' as the discriminator.
 * Required metadata fields are filled with deterministic synthetic values
 * since this is an infrastructure record, not a turn-scoped artifact.
 */
export async function persistBundle(
  be: KnowledgeBackend,
  sessionId: string,
  bundle: SessionBundle,
): Promise<void> {
  await be.put(sessionId, {
    content: JSON.stringify(bundle),
    metadata: {
      traceId: sessionId,
      turnId: sessionId,
      stepperId: 'controller',
      task: 'session-bundle',
      artifactType: BUNDLE_ARTIFACT_TYPE,
      createdAt: new Date().toISOString(),
    },
  });
}

/**
 * Retrieve the latest persisted bundle for a session. Returns a fresh empty
 * bundle if none exists or if the stored content cannot be parsed.
 */
export async function hydrateBundle(
  be: KnowledgeBackend,
  sessionId: string,
): Promise<SessionBundle> {
  const entries = await be.scan(sessionId);
  // Scan returns oldest-first; iterate in reverse so the latest bundle wins.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.metadata.artifactType !== BUNDLE_ARTIFACT_TYPE) continue;
    try {
      return JSON.parse(entry.content) as SessionBundle;
    } catch {
      // malformed entry — keep scanning backwards for a valid one
    }
  }
  return emptyBundle();
}
