import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  type KnowledgeBackend,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeKnowledgeSemanticIndex } from '../embedder-knowledge-index.js';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';

/**
 * Build the ONE knowledge backend shared across all requests (JSONL when a
 * logDir is set, else in-memory). When an embedder is provided, an
 * embedder-backed semantic index is attached so recall ranks by meaning.
 * Pure factory — no MCP dependency, safe to call before MCP resolves.
 */
export function makeKnowledgeBackend(input: {
  logDir?: string;
  embedder?: IEmbedder;
}): KnowledgeBackend {
  const semantic = input.embedder
    ? makeKnowledgeSemanticIndex(input.embedder)
    : undefined;
  return input.logDir
    ? new JsonlKnowledgeBackend(input.logDir, semantic)
    : new InMemoryKnowledgeBackend(semantic);
}
