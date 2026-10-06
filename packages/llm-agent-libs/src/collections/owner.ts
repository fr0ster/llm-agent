// packages/llm-agent-libs/src/collections/owner.ts
import {
  ownerKeyOf,
  type RagMetadata,
  type RecordOwner,
} from '@mcp-abap-adt/llm-agent';

/** `visibility` + the owner key, as written on every profile record (spec §3.1). */
export function ownerMetadata(owner: RecordOwner): Record<string, string> {
  switch (owner.scope) {
    case 'global':
      return { visibility: 'global' };
    case 'group':
      return { visibility: 'group', groupId: owner.groupId };
    case 'user':
      return { visibility: 'user', userId: owner.userId };
    case 'session':
      return {
        visibility: 'session',
        sessionId: owner.sessionId,
        ...(owner.userId !== undefined ? { userId: owner.userId } : {}),
      };
  }
}

const key = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** The owner a record's metadata names; undefined when malformed (never guessed). */
export function ownerFromMetadata(meta: RagMetadata): RecordOwner | undefined {
  switch (meta.visibility) {
    case 'global':
      return { scope: 'global' };
    case 'group': {
      const groupId = key(meta.groupId);
      return groupId ? { scope: 'group', groupId } : undefined;
    }
    case 'user': {
      const userId = key(meta.userId);
      return userId ? { scope: 'user', userId } : undefined;
    }
    case 'session': {
      const sessionId = key(meta.sessionId);
      if (!sessionId) return undefined;
      const userId = key(meta.userId);
      return userId
        ? { scope: 'session', sessionId, userId }
        : { scope: 'session', sessionId };
    }
    default:
      return undefined;
  }
}

/** The owner-qualified item key within one source (JSON, so no separator can collide). */
export function itemKey(
  source: string,
  owner: RecordOwner,
  itemId: string,
): string {
  return JSON.stringify([source, owner.scope, ownerKeyOf(owner), itemId]);
}
