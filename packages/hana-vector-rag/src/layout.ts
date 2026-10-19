import { RagError } from '@mcp-abap-adt/llm-agent';
import { INVALID_CONFIG } from './error-codes.js';

/**
 * The table layout of a config, validated. `undefined` is `per-collection`;
 * any other value than the two layouts is refused, and so is an explicit
 * `autoCreateSchema: true` with `shared` (its tables are deployed outside the
 * app).
 */
export function resolveLayout(
  layout: unknown,
  autoCreateSchema: boolean | undefined,
): 'per-collection' | 'shared' {
  if (
    layout !== undefined &&
    layout !== 'per-collection' &&
    layout !== 'shared'
  ) {
    throw new RagError(
      `layout: ${JSON.stringify(layout)} is invalid (one of: 'per-collection', 'shared')`,
      INVALID_CONFIG,
    );
  }
  if (layout === 'shared' && autoCreateSchema === true) {
    throw new RagError(
      "autoCreateSchema: true is not allowed with layout: 'shared' — the shared tables are deployed outside the app",
      INVALID_CONFIG,
    );
  }
  return layout ?? 'per-collection';
}
