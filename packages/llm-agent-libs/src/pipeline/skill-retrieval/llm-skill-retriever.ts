import {
  type ILlm,
  type ISkillRetriever,
  SKILL_RETRIEVAL_INVALID,
  type SkillCandidate,
} from '@mcp-abap-adt/llm-agent';
import { LlmCatalogueRetriever } from '../catalogue-retrieval/llm-catalogue-retriever.js';

/** Selects skills with a single structured chat request. */
export class LlmSkillRetriever
  extends LlmCatalogueRetriever<SkillCandidate>
  implements ISkillRetriever
{
  constructor(llm: ILlm) {
    super(llm, 'skill', SKILL_RETRIEVAL_INVALID, ({ name, description }) => ({
      name,
      description,
    }));
  }
}
