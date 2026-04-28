/**
 * Base interface for LLM providers
 */
export class BaseLLMProvider {
  config;
  constructor(config) {
    this.config = config;
  }
  /**
   * Validate configuration
   */
  validateConfig() {
    if (!this.config.apiKey) {
      throw new Error('API key is required');
    }
  }
}
//# sourceMappingURL=base-llm-provider.js.map
