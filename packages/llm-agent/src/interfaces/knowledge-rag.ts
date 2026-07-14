import type { CallOptions, LlmTool } from './types.js';

export interface KnowledgeEntryMetadata {
  traceId: string;
  turnId: string;
  stepperId: string;
  parentStepperId?: string;
  task: string;
  artifactType: string;
  toolName?: string;
  /** Identity of a fetched artefact: tool + canonical args (artifactIdentityKey).
   *  Set on `mcp-result` entries so the same fetch is recognised exactly (not
   *  via lossy semantic top-k) — backs the "already fetched" dedup (18.1). */
  identityKey?: string;
  /** Controller run-scope identity (execution-result-control design). `runId`
   *  scopes one user request; `seq` is the stable step index; `attempt` is the
   *  fresh-execution counter (retry/replan reuses the same seq); `status` is the
   *  reviewer's verdict. Exact (runId,seq,attempt) answers "did THIS execution
   *  commit?"; (runId,seq) is the cross-attempt resolution scope. */
  runId?: string;
  seq?: number;
  attempt?: number;
  status?: 'ok' | 'exists' | 'failed' | 'partial';
  /** The reviewer's full control fields, persisted on the artifact so the
   *  COMPLETE Outcome (not just status+approved) survives a crash — `remainder`
   *  drives a partial replan, `note` is the audit reason. No filter equality is
   *  defined on these (they are read back, never queried by value). */
  note?: string;
  remainder?: string;
  createdAt: string;
  /** Monotonic per-run write ordinal; defines latest-write tie-break for recall
   *  dedup when createdAt collides (all artifacts of one synthMeta() call share
   *  the same timestamp). Higher ordinal = later write = wins the dedup. */
  writeOrdinal?: number;
  /** Stable plan-time step identity (controller board). 1:1 with a board entry;
   *  retries share it, a replan-replacement gets a new one + `supersedesStepId`. */
  stepId?: string;
  /** A replan-replacement step's superseded predecessor (§F). */
  supersedesStepId?: string;
  /** Content-hash id of a `plan-decision` (dedup / canonical selection, §F). */
  decisionId?: string;
  /** The decision SLOT a `plan-decision`/`step-start` claim occupies (§F). */
  slotId?: string;
  /** `plan-decision` kind: 'create' | 'replan' | 'expand' | 'page'. */
  kind?: string;
  /** The reviewer's planning-relevant digest, persisted on `step-result` so the
   *  board's per-step digest is reconstructible from artifacts (§A/§F). */
  digest?: string;
  /** Per-round tool-loop identity, persisted on `mcp-result` entries by the
   *  RagRecall context strategy. DISTINCT from `identityKey` (tool+args, used for
   *  fetch dedup): `roundId` labels ONE record()d round so recall can exclude the
   *  raw-tail round (already injected verbatim) by roundId. */
  roundId?: string;
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
  runId?: string;
  seq?: number;
  attempt?: number;
  status?: 'ok' | 'exists' | 'failed' | 'partial';
  stepId?: string;
  decisionId?: string;
  slotId?: string;
  kind?: string;
}

export interface IKnowledgeRagHandle {
  query(
    text: string,
    opts?: { k?: number; filter?: KnowledgeFilter; options?: CallOptions },
  ): Promise<readonly KnowledgeEntry[]>;
  list(filter: KnowledgeFilter): Promise<readonly KnowledgeEntry[]>;
  write(
    entry: {
      content: string;
      metadata: KnowledgeEntryMetadata;
    },
    options?: CallOptions,
  ): Promise<void>;
  fingerprint(): string;
  /**
   * 18.1 identity dedup (optional): exact-match "is this fetch already done?"
   * and the list of fetched-artefact identities, so planners/executors do not
   * re-fetch the same object. Backed by `metadata.identityKey`, NOT by lossy
   * semantic query. Implementations without it fall back to no-dedup behaviour.
   */
  hasArtifact?(identityKey: string): Promise<boolean>;
  listArtifacts?(): Promise<
    ReadonlyArray<{ identityKey: string; toolName?: string; createdAt: string }>
  >;
  /** The stored content of a fetched artefact by identity (for CROSS-step reuse:
   *  another step already fetched it, so this executor injects the stored content
   *  instead of re-calling the tool). Undefined if absent. */
  getArtifact?(identityKey: string): Promise<string | undefined>;
}

export interface IToolsRagHandle {
  query(
    text: string,
    k?: number,
    options?: CallOptions,
  ): Promise<readonly LlmTool[]>;
  lookup(name: string): LlmTool | undefined;
}
