/**
 * Pipeline configuration types for SmartServer.
 *
 * This module defines the YAML-driven pipeline config types.
 * Provider resolution is delegated to `providers.ts`.
 */

import type { SapAICoreCredentials } from '../llm-providers/sap-core-ai.js';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface PipelineLlmProviderConfig {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk';
  /** API key. Required for openai/anthropic/deepseek; optional for sap-ai-sdk. */
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** Maximum number of tokens in the LLM response. */
  maxTokens?: number;
  /** SAP AI Core resource group (used when provider is 'sap-ai-sdk') */
  resourceGroup?: string;
  /** Programmatic OAuth2 credentials for SAP AI Core (bypasses AICORE_SERVICE_KEY env var) */
  credentials?: SapAICoreCredentials;
}

export interface PipelineRagStoreConfig {
  /** 'ollama' | 'openai' | 'in-memory' | 'qdrant'. Default: 'ollama' */
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant';
  /**
   * Embedder name — resolved from the embedder factory registry.
   * Built-in: 'ollama', 'openai'. Consumers can register custom factories.
   * When omitted, defaults to 'ollama'.
   */
  embedder?: string;
  /** Base URL for embedding service or Qdrant server */
  url?: string;
  /** API key (for openai type or Qdrant auth) */
  apiKey?: string;
  /** Embedding model name */
  model?: string;
  /** Qdrant collection name (required for qdrant type) */
  collectionName?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
  /** Weight for vector search (0..1). Default: 0.7 */
  vectorWeight?: number;
  /** Weight for keyword search (0..1). Default: 0.3 */
  keywordWeight?: number;
  /** Per-request timeout for embedding calls in milliseconds. Default: 30 000 */
  timeoutMs?: number;
}

export interface PipelineConfig {
  llm?: {
    /** Primary LLM for the tool-call loop. */
    main: PipelineLlmProviderConfig;
    /** Optional helper LLM for summarization and translation. */
    helper?: PipelineLlmProviderConfig;
    /** LLM used by the intent classifier. If absent, main config is reused at 0.1 temp. */
    classifier?: PipelineLlmProviderConfig;
  };
  rag?: {
    /** RAG store for tool descriptions and domain facts. */
    facts?: PipelineRagStoreConfig;
    /** RAG store for conversation / user feedback. */
    feedback?: PipelineRagStoreConfig;
    /** RAG store for session state. */
    state?: PipelineRagStoreConfig;
  };
  /** One or more MCP servers to connect to simultaneously. */
  mcp?: Array<{
    type: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
  }>;
}
