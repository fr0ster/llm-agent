import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
} from '@mcp-abap-adt/llm-agent';

export async function resolveNeed(
  rag: IKnowledgeRagHandle,
  needText: string,
  k = 5,
): Promise<readonly KnowledgeEntry[]> {
  return rag.query(needText, { k });
}
