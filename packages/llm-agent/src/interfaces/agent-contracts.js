import { SmartAgentError } from './types.js';
export class OrchestratorError extends SmartAgentError {
    constructor(message, code = 'ORCHESTRATOR_ERROR') {
        super(message, code);
        this.name = 'OrchestratorError';
    }
}
//# sourceMappingURL=agent-contracts.js.map