// Appended to tsconfig.typecheck.json. Not a *.test.ts, so the runner skips it;
// under __tests__/, which the package tsconfig excludes, so the build never emits it.
import type { IServerPipelineContext } from '../server-context.js';

declare const ctx: IServerPipelineContext;

// @ts-expect-error — a step may not construct an LLM: makeLlm is gone (§4.6.6)
export const construct = ctx.makeLlm;
// @ts-expect-error — nor read LLM configuration: llmMap is gone (B12)
export const configs = ctx.llmMap;

// the two lookups are what remains
export const lookups: [
  IServerPipelineContext['resolveLlm'],
  IServerPipelineContext['resolveNamedLlm'],
] = [ctx.resolveLlm, ctx.resolveNamedLlm];
