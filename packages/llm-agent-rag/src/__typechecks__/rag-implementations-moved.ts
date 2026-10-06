// packages/llm-agent-rag/src/__typechecks__/rag-implementations-moved.ts
// biome-ignore-all assist/source/organizeImports: negative-import fixture — each import must stay under its @ts-expect-error
// Spec §14.1, D57: the moved names are not exported by @mcp-abap-adt/llm-agent any more
// (a major release, no alias), and are by @mcp-abap-adt/llm-agent-rag.
// @ts-expect-error VectorRag lives in @mcp-abap-adt/llm-agent-rag (migration line 1)
import { VectorRag as OldVectorRag } from '@mcp-abap-adt/llm-agent';
// @ts-expect-error ISearchStrategy moved with VectorRag (migration line 22)
import type { ISearchStrategy as OldISearchStrategy } from '@mcp-abap-adt/llm-agent';
import type {
  IDocumentEnricher,
  IQueryExpander,
  IQueryPreprocessor,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag, type ISearchStrategy, VectorRag } from '../index.js';

void [OldVectorRag, InMemoryRag, VectorRag];
export type _Checked = [
  OldISearchStrategy,
  ISearchStrategy,
  IDocumentEnricher,
  IQueryExpander,
  IQueryPreprocessor,
];
