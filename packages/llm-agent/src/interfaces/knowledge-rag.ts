import type { LlmTool } from './types.js';

export interface KnowledgeEntryMetadata {
  traceId: string;
  turnId: string;
  stepperId: string;
  parentStepperId?: string;
  task: string;
  artifactType: string;
  toolName?: string;
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
}

export interface IToolsRagHandle {
  query(text: string, k?: number): Promise<readonly LlmTool[]>;
  lookup(name: string): LlmTool | undefined;
}
