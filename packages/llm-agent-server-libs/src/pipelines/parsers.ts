// PERMANENT facade: re-exports the pure parsers from config.ts (they STAY there;
// build-stepper-root.ts and others import them from config.ts). Nothing is moved.
export {
  parseStepperCoordinatorConfig,
  type StepperCoordinatorConfig,
} from '../smart-agent/config.js';
