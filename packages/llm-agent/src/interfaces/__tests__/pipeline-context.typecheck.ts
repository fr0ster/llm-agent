// Appended to tsconfig.typecheck.json. Not a *.test.ts, so the runner skips it;
// under __tests__/, so the package build excludes it.
import type { ILlm } from '../llm.js';
import type { IPipelineContext } from '../pipeline-plugin.js';

declare const ctx: IPipelineContext;

// the strict lookup exists and answers an instance
export const named: Promise<ILlm> = ctx.resolveNamedLlm('cheap');

// …and it is required: an object without it is not a pipeline context (§4.6.7)
declare const withoutNamed: Omit<IPipelineContext, 'resolveNamedLlm'>;
// @ts-expect-error — every implementation of IPipelineContext must supply resolveNamedLlm
export const incomplete: IPipelineContext = withoutNamed;
