"use strict";
/**
 * Plugin: audit-log — logs every pipeline request for auditing.
 *
 * Registers a custom stage handler that can be placed at any point
 * in the structured pipeline to log request details.
 *
 * Usage in YAML:
 *   stages:
 *     - id: audit
 *       type: audit-log
 *       config:
 *         level: info          # 'info' | 'warn' | 'error' (default: 'info')
 *         maxTextLength: 200   # truncate logged text (default: 200)
 *
 * Drop this file into:
 *   ~/.config/llm-agent/plugins/audit-log.ts
 *   or ./plugins/audit-log.ts
 *   or any directory specified via --plugin-dir / pluginDir
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageHandlers = void 0;
class AuditLogHandler {
    async execute(ctx, config, span) {
        const level = config.level ?? 'info';
        const maxLen = config.maxTextLength ?? 200;
        const entry = {
            timestamp: new Date().toISOString(),
            sessionId: ctx.sessionId,
            inputLength: ctx.inputText.length,
            inputPreview: ctx.inputText.slice(0, maxLen),
            historyLength: ctx.history.length,
            mcpToolCount: ctx.mcpTools.length,
            externalToolCount: ctx.externalTools.length,
        };
        const line = `[audit:${level}] ${JSON.stringify(entry)}`;
        if (level === 'error') {
            console.error(line);
        }
        else if (level === 'warn') {
            console.warn(line);
        }
        else {
            console.log(line);
        }
        span.setAttribute('audit.logged', true);
        return true; // always continue pipeline
    }
}
// Plugin export — the loader picks this up automatically
exports.stageHandlers = {
    'audit-log': new AuditLogHandler(),
};
//# sourceMappingURL=01-audit-log.js.map