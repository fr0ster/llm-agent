/**
 * RagUpsertHandler — upserts classified subprompts to RAG stores.
 *
 * Reads: `ctx.subprompts`, `ctx.ragStores`
 * Writes: (side effect — data stored in RAG)
 *
 * Upserts subprompts to their matching RAG store. A subprompt's `type`
 * is matched to a store key directly (e.g. type `feedback` → store `feedback`).
 * Skipped when `ragUpsertEnabled` is false.
 */

import type { RagMetadata } from '../../interfaces/types.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class RagUpsertHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    if (ctx.config.ragUpsertEnabled === false) {
      span.setAttribute('skipped', true);
      return true;
    }

    // Match subprompt types to store keys (try exact match, then type + 's')
    const resolveStore = (type: string) =>
      ctx.ragStores[type] ?? ctx.ragStores[`${type}s`];
    const others = ctx.subprompts.filter(
      (sp) =>
        sp.type !== 'action' && sp.type !== 'chat' && resolveStore(sp.type),
    );

    if (others.length === 0) {
      span.setAttribute('count', 0);
      return true;
    }

    const metadata = this._buildMetadata(ctx);

    await Promise.allSettled(
      others.map(async (sp) => {
        const store = resolveStore(sp.type);
        if (store) await store.upsert(sp.text, metadata, ctx.options);
      }),
    );

    span.setAttribute('count', others.length);
    return true;
  }

  private _buildMetadata(ctx: PipelineContext): RagMetadata {
    const p = ctx.config.sessionPolicy;
    if (!p) return {};
    const m: RagMetadata = {};
    if (p.namespace !== undefined) m.namespace = p.namespace;
    if (p.maxSessionAgeMs !== undefined)
      m.ttl = Math.floor((Date.now() + p.maxSessionAgeMs) / 1000);
    return m;
  }
}
