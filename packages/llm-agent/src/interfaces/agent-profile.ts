import type { ISmartAgent } from './builder.js';
import type { ISubAgent } from './subagent.js';
import type { CallOptions, Result } from './types.js';

export type WorkerToolPolicy =
  | 'all'
  | 'read-only'
  | { allow?: string[]; deny?: string[] };
export interface WorkerProfile {
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
  code: 'missing' | 'disabled' | 'unavailable' | 'invalid';
  message: string;
}
export interface AgentPrompts {
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
  createWorker(
    input: { profile: WorkerProfile; workerBase?: string },
    options?: CallOptions,
  ): Promise<Result<ISubAgent, AgentProfileError>>;
  /** Fresh author agent; hosts enforce read-only knowledge tools, with no SAP tools. */
  preparePlanAuthor(
    input: { systemPrompt: string; mode: 'create' | 'revise' },
    options?: CallOptions,
  ): Promise<Result<ISmartAgent, AgentProfileError>>;
  preparePlanner(
    input: { systemPrompt: string },
    options?: CallOptions,
  ): Promise<Result<ISmartAgent, AgentProfileError>>;
}
