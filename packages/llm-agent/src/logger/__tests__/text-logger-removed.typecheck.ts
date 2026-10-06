// Compile-time only (tsconfig.typecheck.json → `npm run typecheck`). Not a *.test.ts, so the runner
// skips it; under __tests__/, so the package build excludes it.
// @ts-expect-error ITextLogger is removed — import ILogger from @mcp-abap-adt/interfaces-utils (spec §13 line 70)
import type { ITextLogger } from '../../index.js';

export type _Removed = ITextLogger;
