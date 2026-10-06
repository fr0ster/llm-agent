import {
  type CallOptions,
  type IDiscriminatorSelector,
  type IIndexNoteSource,
  type IItemIndexer,
  type IndexNote,
  isIndexNoteSource,
  RagError,
  type RecordDraft,
  type Result,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../../util/assert-positive-integer.js';
import { firstClause, nameWords, valueWords } from './derive-tool-facets.js';

/**
 * Generic strategy in NO named composition (spec §7.3.2): it needs `maxValues`,
 * the consumer's number, and a consumer's evidence found it worse on one coarse
 * set. Adds one `value` record per string value of the tool's discriminating
 * parameter. A tool with more values than `maxValues` fails
 * (`TOO_MANY_RECORDS`); values are never silently dropped. Like the inner
 * indexer it never rejects: a throw in its own derivation is an `ok: false`
 * Result with the original as `cause`.
 */
export class EnumValueToolIndexer
  implements IItemIndexer<ToolItem>, IIndexNoteSource<ToolItem>
{
  readonly name = 'enum-values';
  readonly canonicalKind: string;
  readonly maxRecordsPerItem: number;

  constructor(
    readonly inner: IItemIndexer<ToolItem>,
    readonly opts: { discriminator: IDiscriminatorSelector; maxValues: number },
  ) {
    assertPositiveInteger('EnumValueToolIndexer', 'maxValues', opts.maxValues);
    this.canonicalKind = inner.canonicalKind;
    this.maxRecordsPerItem = inner.maxRecordsPerItem + opts.maxValues;
  }

  async toRecords(
    tool: ToolItem,
    options?: CallOptions,
  ): Promise<Result<readonly RecordDraft[], RagError>> {
    // A decorator: the caller's options (abort signal, trace, user) reach the inner indexer.
    const base = await this.inner.toRecords(tool, options);
    if (!base.ok) return base;
    try {
      const p = this.opts.discriminator.select(tool);
      if (!p) return base;
      if (p.values.length > this.opts.maxValues) {
        return {
          ok: false,
          error: new RagError(
            `tool ${tool.name}: ${p.values.length} values of "${p.name}" exceed maxValues ${this.opts.maxValues}`,
            'TOO_MANY_RECORDS',
          ),
        };
      }
      const canonical = base.value.find(
        (d) => d.recordKind === this.canonicalKind,
      );
      const head = [nameWords(tool.originalName), firstClause(tool.description)]
        .filter((s) => s.length > 0)
        .join(' — ');
      const values: RecordDraft[] = p.values.map((v) => ({
        text:
          `${head} — ${nameWords(p.name)}: ${valueWords(v.value)}` +
          (v.description ? ` — ${v.description}` : ''),
        itemId: tool.itemId,
        recordKind: 'value',
        owner: { scope: 'global' },
        ...(canonical ? { itemText: canonical.text } : {}),
        metadata: { name: tool.name, parameter: p.name, value: v.value },
      }));
      return { ok: true, value: [...base.value, ...values] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = new RagError(
        `enum values failed for ${tool.itemId}: ${message}`,
      );
      error.cause = err;
      return { ok: false, error };
    }
  }

  /** S1: the notes of its discriminator and of the indexer it wraps. */
  notesFor(tool: ToolItem): readonly IndexNote[] {
    return [this.opts.discriminator, this.inner].flatMap((x) =>
      isIndexNoteSource<ToolItem>(x) ? x.notesFor(tool) : [],
    );
  }
}
