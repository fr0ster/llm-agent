import type { ILogger as InterfacesUtilsLogger } from '@mcp-abap-adt/interfaces-utils';

/**
 * The ordinary text logger: `info`/`error`/`warn`/`debug(message, meta?)`.
 *
 * This is `@mcp-abap-adt/interfaces-utils`' `ILogger`, re-exported under a
 * second name because llm-agent's own exported `ILogger` — the event one —
 * cannot move: `IPipelineContext.logger` and `IPipelinePlugin` hand it OUT to
 * consumer plugins, so changing that name's shape would break every plugin.
 *
 * Two names for one job is the acknowledged cost of not breaking anyone in
 * this release; converging on one is a rename, and a rename is a major.
 */
export type ITextLogger = InterfacesUtilsLogger;
