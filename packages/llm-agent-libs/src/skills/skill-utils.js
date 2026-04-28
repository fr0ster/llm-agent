/**
 * Shared utilities for skill managers — directory scanning and skill loading.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSkillFromDir } from './filesystem-skill.js';
/**
 * Scan multiple directories for skill subdirectories, load each, and return
 * the resulting skills. Duplicate names from later directories override earlier ones.
 *
 * @param dirs - Directories to scan for skill subdirectories.
 * @param normalizeMeta - Optional function to normalize vendor-specific frontmatter keys.
 * @param enrichSkill - Optional async function to enrich a loaded skill (e.g. with vendor config).
 */
export async function scanDirsForSkills(dirs, normalizeMeta, enrichSkill) {
  const byName = new Map();
  for (const baseDir of dirs) {
    let entries;
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
        skill.name = normalized.name;
        skill.description = normalized.description;
      }
      if (enrichSkill) {
        await enrichSkill(skill, skillDir);
      }
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}
//# sourceMappingURL=skill-utils.js.map
