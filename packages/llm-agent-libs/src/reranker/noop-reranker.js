export class NoopReranker {
  async rerank(_query, results, _options) {
    return { ok: true, value: results };
  }
}
//# sourceMappingURL=noop-reranker.js.map
