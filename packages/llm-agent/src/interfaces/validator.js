import { SmartAgentError } from './types.js';
export class ValidatorError extends SmartAgentError {
    constructor(message, code = 'VALIDATOR_ERROR') {
        super(message, code);
        this.name = 'ValidatorError';
    }
}
//# sourceMappingURL=validator.js.map