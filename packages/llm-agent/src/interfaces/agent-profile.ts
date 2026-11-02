import type { TrustMap } from '../trust.js';
import type { ISmartAgent } from './builder.js';
import type { ISubAgent } from './subagent.js';
import type { CallOptions, Result } from './types.js';

export type WorkerToolPolicy =
  | 'all'
  | 'read-only'
  | { allow?: string[]; deny?: string[] };
export interface WorkerProfile {
  model?: string;
  trust?: TrustMap;
  name: string;
  description: string;
  systemPrompt: string;
  tools: WorkerToolPolicy;
  result: 'report' | 'verdict';
}
export interface WorkerProfileSummary {
  name: string;
  description: string;
  result: WorkerProfile['result'];
}
export interface AgentProfileError {
  code:
    | 'missing'
    | 'disabled'
    | 'unavailable'
    | 'invalid'
    | 'MODEL_NOT_ALLOWED';
  message: string;
}
export interface AgentPrompts {
  trust?: {
    coordinator?: TrustMap;
    plannerCreate?: TrustMap;
    plannerRevise?: TrustMap;
  };
  workerBase?: string;
  planner?: string;
  coordinator?: string;
  plannerCreate?: string;
  plannerRevise?: string;
}
/** Exact, fresh lookups of enabled profiles; no positive TTL or stale fallback. */
export interface IAgentProfileSource {
  list(
    options?: CallOptions,
  ): Promise<Result<WorkerProfileSummary[], AgentProfileError>>;
  get(
    name: string,
    options?: CallOptions,
  ): Promise<Result<WorkerProfile, AgentProfileError>>;
  getPrompts(
    options?: CallOptions,
  ): Promise<Result<AgentPrompts, AgentProfileError>>;
}
/** Hosts enforce tool ceilings at definition and execution time, including nested calls.
 * Verdict workers always have a read-only ceiling. Deny wins over allow.
 * Supplied base/profile text must use the context assembler's static preamble. */
export interface IAgentProfileRunner {
  /** Synchronous host model policy, checked before a task is queued. */
  validateModel?(model: string): Result<void, AgentProfileError>;
  createWorker(
    input: { profile: WorkerProfile; workerBase?: string; model?: string },
    options?: CallOptions,
  ): Promise<Result<ISubAgent, AgentProfileError>>;
  /** Fresh author agent; hosts enforce read-only knowledge tools, with no SAP tools. */
  preparePlanAuthor?(
    input: {
      systemPrompt: string;
      mode: 'create' | 'revise';
      trust?: TrustMap;
    },
    options?: CallOptions,
  ): Promise<Result<ISmartAgent, AgentProfileError>>;
  preparePlanner(
    input: { systemPrompt: string; trust?: TrustMap },
    options?: CallOptions,
  ): Promise<Result<ISmartAgent, AgentProfileError>>;
}

/** Host construction seam for a fresh, read-only plan author. */
export interface AgentProfileRunnerHost {
  buildPlanAuthor(input: {
    systemPrompt: string;
    mode: 'create' | 'revise';
    trust?: TrustMap;
  }): Promise<Result<ISmartAgent, AgentProfileError>>;
}
