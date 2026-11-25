import {
  type ILlm,
  type IToolRetriever,
  TOOL_RETRIEVAL_INVALID,
  type ToolCandidate,
} from '@mcp-abap-adt/llm-agent';
import { LlmCatalogueRetriever } from '../catalogue-retrieval/llm-catalogue-retriever.js';

/** Selects MCP tools with a single structured chat request. */
export class LlmToolRetriever
  extends LlmCatalogueRetriever<ToolCandidate>
  implements IToolRetriever
{
  constructor(llm: ILlm) {
    super(
      llm,
      'tool',
      TOOL_RETRIEVAL_INVALID,
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }),
    );
  }
}
