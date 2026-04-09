/**
 * Plugin types for SmartAgent extensibility.
 *
 * Plugins allow consumers to attach named RAG stores (with lifecycle scopes)
 * and extend classifier prompts without modifying core agent code.
 */

import type { IRag } from './rag.js';

// ---------------------------------------------------------------------------
// RAG scope
// ---------------------------------------------------------------------------

/**
 * Lifecycle scope of a RAG store provided by a plugin.
 *
 * - `'global'`  — shared across all users and sessions; evicted only on restart.
 * - `'user'`    — scoped to a single user; evicted when the user session ends.
 * - `'session'` — scoped to a single conversation session; evicted when the session ends.
 */
export type RagScope = 'global' | 'user' | 'session';

// ---------------------------------------------------------------------------
// IRagStoreConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a single RAG store contributed by a plugin.
 */
export interface IRagStoreConfig {
  /** The RAG store implementation. */
  rag: IRag;
  /** Lifecycle scope that controls when the store is evicted. */
  scope: RagScope;
  /**
   * Optional time-to-live in seconds.
   * When set, records older than this value are excluded from retrieval.
   */
  ttl?: number;
}

// ---------------------------------------------------------------------------
// ISmartAgentPlugin
// ---------------------------------------------------------------------------

/**
 * A SmartAgent plugin that contributes RAG stores and optional classifier extensions.
 *
 * Plugins are passed to consumer pipeline implementations, not to the builder.
 * The default pipeline ignores plugins — only custom consumer pipelines use them.
 */
export interface ISmartAgentPlugin {
  /** Unique plugin identifier. */
  name: string;
  /**
   * Named RAG stores contributed by this plugin.
   * Keys are store names used to address results in pipeline stages.
   */
  ragStores: Record<string, IRagStoreConfig>;
  /**
   * Optional text appended to the classifier system prompt.
   * Use this to teach the classifier about domain-specific intents
   * introduced by this plugin.
   */
  classifierPromptExtension?: string;
}
