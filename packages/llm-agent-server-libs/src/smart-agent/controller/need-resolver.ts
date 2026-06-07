import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
  KnowledgeFilter,
} from '@mcp-abap-adt/llm-agent';

export async function resolveNeed(
  rag: IKnowledgeRagHandle,
  needText: string,
  k = 5,
  filter?: KnowledgeFilter,
): Promise<readonly KnowledgeEntry[]> {
  return rag.query(needText, { k, filter });
}
