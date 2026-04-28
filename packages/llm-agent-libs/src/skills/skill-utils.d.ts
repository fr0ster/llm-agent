/**
 * Shared utilities for skill managers — directory scanning and skill loading.
 */
import type { ISkill, ISkillMeta } from '@mcp-abap-adt/llm-agent';
import { type FileSystemSkill } from './filesystem-skill.js';
/**
 * Scan multiple directories for skill subdirectories, load each, and return
 * the resulting skills. Duplicate names from later directories override earlier ones.
 *
 * @param dirs - Directories to scan for skill subdirectories.
 * @param normalizeMeta - Optional function to normalize vendor-specific frontmatter keys.
 * @param enrichSkill - Optional async function to enrich a loaded skill (e.g. with vendor config).
 */
export declare function scanDirsForSkills(
  dirs: string[],
  normalizeMeta?: (meta: ISkillMeta) => ISkillMeta,
  enrichSkill?: (skill: FileSystemSkill, dir: string) => Promise<void>,
): Promise<ISkill[]>;
//# sourceMappingURL=skill-utils.d.ts.map
