/** Consumer-owned strategy contributing HTTP headers to MCP requests. The engine
 *  imposes NO MCP request timeout; a consumer may use this to convey a "willing to
 *  wait longer" hint (or anything else) to the server. Default = no-op. */
export interface IMcpRequestHeadersStrategy {
  /** Headers merged into the MCP connection requestInit at connect. */
  headers(): Record<string, string>;
}
