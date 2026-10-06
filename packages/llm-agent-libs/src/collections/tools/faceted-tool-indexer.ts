// packages/llm-agent-libs/src/collections/tools/faceted-tool-indexer.ts
import type {
  IItemIndexer,
  IToolFacet,
  IToolTextComposer,
  RagError,
  RecordDraft,
  Result,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { ParameterNamesToolText } from './tool-text.js';

const GLOBAL = { scope: 'global' } as const;

/**
 * `full` (canonical, not a facet — it cannot be left out) + one record per
 * facet that yields text. Tool catalogs are global. The `full` text comes from
 * the injected provider text composer (F4); absent → C0 (30.1.0's text plus parameter names).
 */
export class FacetedToolIndexer implements IItemIndexer<ToolItem> {
  readonly name = 'faceted';
  readonly canonicalKind = 'full';
  readonly maxRecordsPerItem: number;
  readonly text: IToolTextComposer;

  constructor(
    readonly facets: readonly IToolFacet[],
    opts: { text?: IToolTextComposer } = {},
  ) {
    this.text = opts.text ?? new ParameterNamesToolText();
    const kinds = new Set<string>();
    for (const f of facets) {
      if (f.kind === 'full' || kinds.has(f.kind)) {
        throw new Error(
          `FacetedToolIndexer: facet kind "${f.kind}" is reserved or repeated`,
        );
      }
      kinds.add(f.kind);
    }
    this.maxRecordsPerItem = 1 + facets.length;
  }

  async toRecords(
    tool: ToolItem,
  ): Promise<Result<readonly RecordDraft[], RagError>> {
    const full = this.text.compose(tool);
    const drafts: RecordDraft[] = [
      {
        text: full,
        itemId: tool.itemId,
        recordKind: 'full',
        owner: GLOBAL,
        metadata: { name: tool.name, definitionChars: tool.definitionChars },
      },
    ];
    for (const facet of this.facets) {
      const text = facet.derive(tool);
      if (!text) continue;
      drafts.push({
        text,
        itemId: tool.itemId,
        recordKind: facet.kind,
        owner: GLOBAL,
        itemText: full,
        metadata: { name: tool.name },
      });
    }
    return { ok: true, value: drafts };
  }
}
