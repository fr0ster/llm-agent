import type {
  IKnowledgeRagHandle,
  KnowledgeEntryMetadata,
} from '@mcp-abap-adt/llm-agent';

export interface Artifact extends KnowledgeEntryMetadata {
  content: string;
}

export async function writeArtifact(
  rag: IKnowledgeRagHandle,
  artifact: Artifact,
): Promise<void> {
  const { content, ...metadata } = artifact;
  await rag.write({ content, metadata });
}
