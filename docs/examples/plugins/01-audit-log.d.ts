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
import type { ISpan, IStageHandler, PipelineContext } from '@mcp-abap-adt/llm-agent-server';
declare class AuditLogHandler implements IStageHandler {
    execute(ctx: PipelineContext, config: Record<string, unknown>, span: ISpan): Promise<boolean>;
}
export declare const stageHandlers: {
    'audit-log': AuditLogHandler;
};
export {};
//# sourceMappingURL=01-audit-log.d.ts.map