import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  embedderSectionFor,
  type SmartServerEmbedderConfig,
} from './rag-config.js';
import type { SkillHostEmbedderConfig } from './skill-plugins-host-factory.js';

/**
 * The skill host's embedder resolver: it asks for a `document` half (skills it
 * writes) and a `query` half (recall text). Reusing the agent's embedders, each
 * role gets its own half; a dedicated symmetric embedder is ONE instance for
 * both; a dedicated asymmetric one is built per half with its input type.
 */
export function skillHostEmbedderResolver(opts: {
  reuse?: { document: IEmbedder; query: IEmbedder };
  resolve: (section: SmartServerEmbedderConfig) => IEmbedder;
}): (ec: SkillHostEmbedderConfig) => IEmbedder {
  let symmetric: IEmbedder | undefined;
  return (ec) => {
    if (opts.reuse) return opts.reuse[ec.inputType];
    const section = embedderSectionFor(ec.embedder, ec.model);
    if (!ec.asymmetric || section.factory !== undefined) {
      symmetric ??= opts.resolve(section);
      return symmetric;
    }
    return opts.resolve({ ...section, inputType: ec.inputType });
  };
}
