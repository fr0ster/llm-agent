import type {
  IIdStrategy,
  IRag,
  IRagEditor,
  IRagProvider,
  RagCollectionOwner,
  RagCollectionScope,
  RagProviderCreateCollectionOptions,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
import {
  validateRagAttributes,
  validateRagOwner,
} from '../catalog/validation.js';
import { UnsupportedScopeError } from '../corrections/errors.js';
import {
  DirectEditStrategy,
  ImmutableEditStrategy,
} from '../strategies/edit/index.js';
import {
  GlobalUniqueIdStrategy,
  SessionScopedIdStrategy,
} from '../strategies/id/index.js';

export abstract class AbstractRagProvider implements IRagProvider {
  abstract readonly name: string;
  abstract readonly kind: string;
  abstract readonly editable: boolean;
  abstract readonly supportedScopes: readonly RagCollectionScope[];

  protected idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;

  abstract createCollection(
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

  protected checkScope(scope: RagCollectionScope): Result<void, RagError> {
    if (!this.supportedScopes.includes(scope)) {
      return { ok: false, error: new UnsupportedScopeError(this.name, scope) };
    }
    return { ok: true, value: undefined };
  }

  /**
   * The owner, the scope and the attributes, checked before any backend is
   * touched — for callers no compiler saw (§6.3). Returns the owner with only
   * the key its scope selects.
   */
  protected checkCreateOptions(
    opts: RagProviderCreateCollectionOptions,
  ): Result<RagCollectionOwner, RagError> {
    const owner = validateRagOwner(opts);
    if (!owner.ok) return owner;
    const scope = this.checkScope(owner.value.scope);
    if (!scope.ok) return scope;
    const attributes = validateRagAttributes(opts.attributes);
    if (!attributes.ok) return attributes;
    return owner;
  }

  protected pickIdStrategy(opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }): IIdStrategy {
    if (this.idStrategyFactory) return this.idStrategyFactory(opts);
    if (opts.scope === 'session' && opts.sessionId) {
      return new SessionScopedIdStrategy(opts.sessionId);
    }
    return new GlobalUniqueIdStrategy();
  }

  protected buildEditor(rag: IRag, idStrategy: IIdStrategy): IRagEditor {
    if (!this.editable) return new ImmutableEditStrategy(this.name);
    const writer = rag.writer?.();
    if (!writer) {
      throw new Error(
        `Provider '${this.name}' requires an IRag with writer() support for editable mode`,
      );
    }
    return new DirectEditStrategy(writer, idStrategy);
  }
}
