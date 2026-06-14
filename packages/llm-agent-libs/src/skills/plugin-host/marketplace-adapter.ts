import type {
  SkillGroupInfo,
  SkillIngestResult,
  SkillRecord,
} from '@mcp-abap-adt/llm-agent';
import { parseFrontmatter } from '../../utils/parse-frontmatter.js';
import { chunkSkill } from './chunker.js';

export interface MarketplaceInput {
  source: string; // stable sourceId
  plugins: ReadonlyArray<{
    plugin: string;
    version: string;
    skills: ReadonlyArray<{ skill: string; skillMd: string }>;
  }>;
  chunk: { maxChars: number };
  /** Strategy placement: plugin → its group + description. */
  placement: (plugin: string) => { group: string; description: string };
}

/** Pure, FS-free: parse SKILL.md strings, chunk, and place records into collections. */
export function buildIngestResult(input: MarketplaceInput): SkillIngestResult {
  const records: SkillRecord[] = [];
  const collections = new Map<string, SkillGroupInfo>();
  for (const p of input.plugins) {
    const place = input.placement(p.plugin);
    if (!collections.has(place.group)) {
      collections.set(place.group, {
        group: place.group,
        description: place.description,
        collection: place.group,
      });
    }
    for (const s of p.skills) {
      const { meta, body } = parseFrontmatter<Record<string, unknown>>(
        s.skillMd,
      );
      const description = String(meta.description ?? '');
      records.push(
        ...chunkSkill(
          {
            source: input.source,
            plugin: p.plugin,
            version: p.version,
            skill: s.skill,
            group: place.group,
            description,
            body,
          },
          input.chunk,
        ),
      );
    }
  }
  return { collections: [...collections.values()], records };
}
