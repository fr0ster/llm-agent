"use strict";
/**
 * Plugin: content-filter — output validator that blocks sensitive content.
 *
 * Replaces the default output validator with a keyword-based filter.
 * Checks LLM responses for forbidden patterns and rejects them.
 *
 * Usage in YAML:
 *   pluginDir: ./plugins
 *   # No additional YAML config needed — the validator is applied globally.
 *   # All LLM responses pass through this filter automatically.
 *
 * Drop this file into your plugin directory.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.outputValidator = void 0;
// Error class for validator failures
class ValidatorError extends Error {
    code;
    constructor(message, code = 'VALIDATOR_ERROR') {
        super(message);
        this.name = 'ValidatorError';
        this.code = code;
    }
}
/**
 * Forbidden patterns — adjust for your compliance requirements.
 * Each entry has a regex pattern and a human-readable reason.
 */
const FORBIDDEN_PATTERNS = [
    { pattern: /password\s*[:=]\s*\S+/gi, reason: 'Possible password leak' },
    { pattern: /\b\d{16}\b/g, reason: 'Possible credit card number' },
    {
        pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
        reason: 'Private key detected',
    },
    { pattern: /AKIA[0-9A-Z]{16}/g, reason: 'AWS access key detected' },
];
class ContentFilterValidator {
    async validate(content, _context, _options) {
        for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
            // Reset regex state (global flag)
            pattern.lastIndex = 0;
            if (pattern.test(content)) {
                return {
                    ok: true,
                    value: {
                        valid: false,
                        reason: `Content blocked: ${reason}`,
                    },
                };
            }
        }
        return {
            ok: true,
            value: { valid: true },
        };
    }
}
// Plugin export
exports.outputValidator = new ContentFilterValidator();
//# sourceMappingURL=02-content-filter.js.map