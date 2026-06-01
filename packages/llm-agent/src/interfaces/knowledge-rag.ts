import type { LlmTool } from './types.js';

export interface KnowledgeEntryMetadata {
  traceId: string;
  turnId: string;
  stepperId: string;
  parentStepperId?: string;
  task: string;
  artifactType: string;
  toolName?: string;
  /** Identity of a fetched artefact: tool + canonical args (artifactIdentityKey).
   *  Set on `mcp-result` entries so the same fetch is recognised exactly (not
   *  via lossy semantic top-k) — backs the "already fetched" dedup (18.1). */
  identityKey?: string;
  createdAt: string;
}

export interface KnowledgeEntry {
  content: string;
  metadata: KnowledgeEntryMetadata;
}

export interface KnowledgeFilter {
  traceId?: string;
  turnId?: string;
  stepperId?: string;
  parentStepperId?: string;
  artifactType?: string | readonly string[];
  toolName?: string;
}

export interface IKnowledgeRagHandle {
  query(
    text: string,
    opts?: { k?: number; filter?: KnowledgeFilter },
  ): Promise<readonly KnowledgeEntry[]>;
  list(filter: KnowledgeFilter): Promise<readonly KnowledgeEntry[]>;
  write(entry: {
    content: string;
    metadata: KnowledgeEntryMetadata;
  }): Promise<void>;
  fingerprint(): string;
  /**
   * 18.1 identity dedup (optional): exact-match "is this fetch already done?"
   * and the list of fetched-artefact identities, so planners/executors do not
   * re-fetch the same object. Backed by `metadata.identityKey`, NOT by lossy
   * semantic query. Implementations without it fall back to no-dedup behaviour.
   */
  hasArtifact?(identityKey: string): Promise<boolean>;
  listArtifacts?(): Promise<
    ReadonlyArray<{ identityKey: string; toolName?: string; createdAt: string }>
  >;
  /** The stored content of a fetched artefact by identity (for CROSS-step reuse:
   *  another step already fetched it, so this executor injects the stored content
   *  instead of re-calling the tool). Undefined if absent. */
  getArtifact?(identityKey: string): Promise<string | undefined>;
}

export interface IToolsRagHandle {
  query(text: string, k?: number): Promise<readonly LlmTool[]>;
  lookup(name: string): LlmTool | undefined;
}
