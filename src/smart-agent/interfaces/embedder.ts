export interface IEmbedder {
  /** Compute the embedding vector for `text`. */
  embed(text: string): Promise<number[]>;

  /**
   * Optional health check — should resolve if the endpoint is reachable,
   * throw otherwise. Called once on startup to emit a warning when the
   * backing service is down.
   */
  checkHealth?(): Promise<void>;
}
