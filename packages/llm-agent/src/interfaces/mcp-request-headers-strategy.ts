/** Consumer-owned strategy contributing HTTP headers to MCP requests. Independent
 *  of the client-side request timeout (`MCPClientConfig.timeout`/`toolTimeouts`): a
 *  consumer may use this to convey a "willing to wait longer" hint (or anything
 *  else) to the server via headers. Default = no-op. */
export interface IMcpRequestHeadersStrategy {
  /** Headers merged into the MCP connection requestInit at connect. */
  headers(): Record<string, string>;
}
