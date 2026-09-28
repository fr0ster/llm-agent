import { InMemoryRag, type IRag } from '@mcp-abap-adt/llm-agent';
import { makeRag as libMakeRag } from '@mcp-abap-adt/llm-agent-rag';
import {
  isInMemoryInput,
  type MakeRagInput,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { DEFAULT_STORE_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

/**
 * `BuildAgentDeps.makeRag` (§8 item 4): the serializable store section plus,
 * where the store needs one, a resolved embedder — and this body is the
 * conversion into the library's typed `RagResolution` (§4.6.4). The pair's
 * discriminant is nested (`store.type`), which does not narrow the pair, so
 * B10's `isInMemoryInput` narrows the whole input before `embedder` is known
 * to be present.
 */
export function createMakeRag(
  lookup: Lookup,
  impl: typeof libMakeRag = libMakeRag,
): (input: MakeRagInput) => Promise<IRag> {
  return async (input) => {
    if (isInMemoryInput(input)) {
      const { credentialRef, ...address } = input.store;
      lookup(credentialRef, DEFAULT_STORE_REF, 'in-memory').refuseAny();
      return input.embedder
        ? impl({ ...address, embedder: input.embedder })
        : // keyword-only: no namespace, as on main; preprocessors/enrichers are
          // not YAML fields, so nothing a file configured is lost (§4.6.4)
          new InMemoryRag({ dedupThreshold: address.dedupThreshold });
    }
    const { embedder, store } = input;
    switch (store.type) {
      case 'qdrant': {
        const { credentialRef, ...address } = store;
        const entry = lookup(credentialRef, DEFAULT_STORE_REF, 'qdrant');
        return impl({ ...address, embedder, ...entry.optional('api-key') });
      }
      case 'pg-vector': {
        const { credentialRef, ...address } = store;
        const entry = lookup(credentialRef, DEFAULT_STORE_REF, 'pg-vector');
        return impl({
          ...address,
          embedder,
          ...entry.optional('secret-login'),
        });
      }
      case 'hana-vector': {
        const { credentialRef, ...address } = store;
        const entry = lookup(credentialRef, DEFAULT_STORE_REF, 'hana-vector');
        return impl({
          ...address,
          embedder,
          credential: entry.require('secret-login'),
        });
      }
    }
  };
}
