// Imported as a value (not just re-exported) because it is instantiated for
// DEFAULT_TOOL_SELECTION below — do not collapse into the re-export.
import { TopKToolSelection } from './top-k.js';

export { ScoreThresholdToolSelection } from './score-threshold.js';
export { TopKToolSelection } from './top-k.js';

/** Shared default used when no strategy is configured. */
export const DEFAULT_TOOL_SELECTION = new TopKToolSelection();
