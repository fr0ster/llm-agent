// packages/llm-agent-libs/src/collections/tools-binding.ts
import {
  type CollectionStore,
  type IBoundCollection,
  type ICollectionProfile,
  type IRag,
  isRagDecorator,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import {
  hasRetrievalStrategy,
  StrategyRag,
} from '../retrieval/strategy-rag.js';

/** Bound store (the binding's `rag`) → its binding: what `toolsBindingOf` finds. */
const BINDINGS = new WeakMap<IRag, IBoundCollection<ToolItem>>();
/** The store a binding was made FOR (`target.rag`) → that binding: bind once (spec §6.1).
 *  Separate from BINDINGS, so the raw store itself still carries no binding. */
const BOUND_TARGETS = new WeakMap<IRag, IBoundCollection<ToolItem>>();

/** The tools binding `rag` carries, or one of the stores it decorates (≤ 16 levels). */
export function toolsBindingOf(
  rag: IRag,
): IBoundCollection<ToolItem> | undefined {
  let cur: IRag | undefined = rag;
  for (let depth = 0; cur && depth < 16; depth++) {
    const b = BINDINGS.get(cur);
    if (b) return b;
    cur = isRagDecorator(cur) ? cur.inner : undefined;
  }
  return undefined;
}

/**
 * Bind a tools profile to a store ONCE (spec §6.1): the server binds at
 * creation, the builder reuses it. The bound store always carries the
 * retrieval (a consumer profile whose `rag` lacks it gets a StrategyRag).
 */
export function bindToolsProfile(
  profile: ICollectionProfile<ToolItem>,
  target: CollectionStore,
): IBoundCollection<ToolItem> {
  const existing = toolsBindingOf(target.rag) ?? BOUND_TARGETS.get(target.rag);
  if (existing) return existing;
  const bound = profile.bind(target);
  const rag = hasRetrievalStrategy(bound.rag)
    ? bound.rag
    : new StrategyRag(bound.rag, bound.retrieval);
  const registered: IBoundCollection<ToolItem> =
    rag === bound.rag
      ? bound
      : {
          key: bound.key,
          profileName: bound.profileName,
          rag,
          retrieval: bound.retrieval,
          index: (items, o) => bound.index(items, o),
          remove: (refs, o) => bound.remove(refs, o),
          get: (ref, o) => bound.get(ref, o),
        };
  BINDINGS.set(rag, registered);
  BOUND_TARGETS.set(target.rag, registered);
  return registered;
}
