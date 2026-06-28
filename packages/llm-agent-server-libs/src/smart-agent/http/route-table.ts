/**
 * Declarative HTTP route table for SmartServer.
 *
 * Replaces the ~300-line if/else chain in `SmartServer._handle` with an ordered
 * list of routes. Dispatch iterates the routes in registration order; the first
 * route whose method AND path match handles the request. No match ⇒ 404. The
 * order of `add()` calls is therefore semantically significant and MUST mirror
 * the original `_handle` branch order to stay behaviour-preserving.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ILlmApiAdapter,
  IModelProvider,
  IRequestLogger,
} from '@mcp-abap-adt/llm-agent';
import type {
  HealthChecker,
  SmartAgent,
  SmartAgentHandle,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServer } from '../smart-server.js';
import { jsonError } from './response-helpers.js';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  rawUrl: string;
  urlPath: string;
  method: string;
  /** Pre-computed once in `_handle`; reused by health/messages/chat. */
  ready: boolean;
  server: SmartServer;
  requestLogger: IRequestLogger;
  smartAgent: SmartAgent;
  chat: SmartAgentHandle['chat'];
  streamChat: SmartAgentHandle['streamChat'];
  log: (e: Record<string, unknown>) => void;
  healthChecker: HealthChecker;
  modelProvider?: IModelProvider;
  adapterMap?: Map<string, ILlmApiAdapter>;
}

export type RouteHandler = (rc: RouteContext) => Promise<void>;

export interface IRoute {
  /** HTTP method(s) this route serves, or `'*'` to match any method. */
  method: string | string[];
  match(urlPath: string): RegExpMatchArray | boolean;
  handle: RouteHandler;
}

export class HttpRouteTable {
  private readonly routes: IRoute[] = [];

  add(route: IRoute): this {
    this.routes.push(route);
    return this;
  }

  async dispatch(rc: RouteContext): Promise<void> {
    for (const route of this.routes) {
      const methodOk =
        route.method === '*' ||
        (Array.isArray(route.method)
          ? route.method.includes(rc.method)
          : route.method === rc.method);
      if (!methodOk) continue;
      const m = route.match(rc.urlPath);
      if (m) {
        await route.handle(rc);
        return;
      }
    }
    rc.res.writeHead(404, { 'Content-Type': 'application/json' });
    rc.res.end(
      jsonError(`Cannot ${rc.method} ${rc.urlPath}`, 'invalid_request_error'),
    );
  }
}
