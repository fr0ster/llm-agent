import type {
  IIdStrategy,
  IRag,
  IRagEditor,
  IRagProvider,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { RagError, Result } from '../../interfaces/types.js';
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
    opts: {
      scope: RagCollectionScope;
      sessionId?: string;
      userId?: string;
    },
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

  protected checkScope(scope: RagCollectionScope): Result<void, RagError> {
    if (!this.supportedScopes.includes(scope)) {
      return { ok: false, error: new UnsupportedScopeError(this.name, scope) };
    }
    return { ok: true, value: undefined };
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
