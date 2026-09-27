// Facade: re-exports the pure stepper parser from stepper-config.ts. This is the
// only logic `legacy/stepper.ts` still reaches through this file; the linear
// dialect (`parseLinearConfig`) moved to `smart-agent/pipeline-settings.ts`
// (`parseLinearSettings`) — the server parses a plugin's section, not the plugin.
export {
  parseStepperCoordinatorConfig,
  type StepperCoordinatorConfig,
} from '../smart-agent/stepper-config.js';
