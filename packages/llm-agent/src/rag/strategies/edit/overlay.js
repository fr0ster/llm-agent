import { DirectEditStrategy } from './direct.js';
/**
 * Write-only edit strategy that pairs with OverlayRag on the read side.
 * Delegates to a single overlay writer; does not know about the base store.
 */
export class OverlayEditStrategy extends DirectEditStrategy {}
//# sourceMappingURL=overlay.js.map
