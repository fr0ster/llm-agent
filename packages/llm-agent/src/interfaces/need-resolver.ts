export interface INeedResolver {
  /** Inspect an LLM utterance for an unmet-capability signal. Returns a
   *  tools-RAG query string to discover the needed capability, or undefined
   *  for a clean answer / normal tool call.
   *  v1 scope: only `queryToolsRag`. (Reserved for 18.x: queryKnowledgeRag,
   *  injectTools — intentionally NOT in the v1 contract so there are no dead
   *  public fields the executor ignores; see review R1-F5.) */
  resolve(llmResponse: string): Promise<{ queryToolsRag: string } | undefined>;
}
