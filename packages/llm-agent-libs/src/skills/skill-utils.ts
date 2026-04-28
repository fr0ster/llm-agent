/**
 * Shared utilities for skill managers — directory scanning and skill loading.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ISkill, ISkillMeta } from '@mcp-abap-adt/llm-agent';
import { type FileSystemSkill, loadSkillFromDir } from './filesystem-skill.js';

/**
 * Scan multiple directories for skill subdirectories, load each, and return
 * the resulting skills. Duplicate names from later directories override earlier ones.
 *
 * @param dirs - Directories to scan for skill subdirectories.
 * @param normalizeMeta - Optional function to normalize vendor-specific frontmatter keys.
 * @param enrichSkill - Optional async function to enrich a loaded skill (e.g. with vendor config).
 */
export async function scanDirsForSkills(
  dirs: string[],
  normalizeMeta?: (meta: ISkillMeta) => ISkillMeta,
  enrichSkill?: (skill: FileSystemSkill, dir: string) => Promise<void>,
): Promise<ISkill[]> {
  const byName = new Map<string, ISkill>();

  for (const baseDir of dirs) {
    let entries: string[];
    try {
      const dirEntries = await readdir(baseDir, { withFileTypes: true });
      entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // Directory doesn't exist — skip
    }

    for (const entry of entries) {
      const skillDir = join(baseDir, entry);
      const skill = await loadSkillFromDir(skillDir);
      if (!skill) continue;

      if (normalizeMeta) {
        const normalized = normalizeMeta(skill.meta);
        Object.assign(skill.meta, normalized);
        // Update name/description if changed by normalization
        (skill as { name: string }).name = normalized.name;
        (skill as { description: string }).description = normalized.description;
      }

      if (enrichSkill) {
        await enrichSkill(skill, skillDir);
      }

      byName.set(skill.name, skill);
    }
  }

  return [...byName.values()];
}
