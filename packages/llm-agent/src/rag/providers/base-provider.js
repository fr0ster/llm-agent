import { UnsupportedScopeError } from '../corrections/errors.js';
import { DirectEditStrategy, ImmutableEditStrategy, } from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy, SessionScopedIdStrategy, } from '../strategies/id/index.js';
export class AbstractRagProvider {
    idStrategyFactory;
    checkScope(scope) {
        if (!this.supportedScopes.includes(scope)) {
            return { ok: false, error: new UnsupportedScopeError(this.name, scope) };
        }
        return { ok: true, value: undefined };
    }
    pickIdStrategy(opts) {
        if (this.idStrategyFactory)
            return this.idStrategyFactory(opts);
        if (opts.scope === 'session' && opts.sessionId) {
            return new SessionScopedIdStrategy(opts.sessionId);
        }
        return new GlobalUniqueIdStrategy();
    }
    buildEditor(rag, idStrategy) {
        if (!this.editable)
            return new ImmutableEditStrategy(this.name);
        const writer = rag.writer?.();
        if (!writer) {
            throw new Error(`Provider '${this.name}' requires an IRag with writer() support for editable mode`);
        }
        return new DirectEditStrategy(writer, idStrategy);
    }
}
//# sourceMappingURL=base-provider.js.map