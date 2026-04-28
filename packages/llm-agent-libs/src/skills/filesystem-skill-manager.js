/**
 * FileSystemSkillManager — discovers skills from configurable directories.
 *
 * The simplest skill manager variant — no vendor-specific logic.
 * Takes an array of directories to scan for skill subdirectories.
 */
import { SkillError } from '@mcp-abap-adt/llm-agent';
import { scanDirsForSkills } from './skill-utils.js';
export class FileSystemSkillManager {
  dirs;
  cache;
  constructor(dirs) {
    this.dirs = dirs;
  }
  async listSkills(_options) {
    if (this.cache) return { ok: true, value: this.cache };
    try {
      const skills = await scanDirsForSkills(this.dirs);
      this.cache = skills;
      return { ok: true, value: skills };
    } catch (err) {
      return {
        ok: false,
        error: new SkillError(`Failed to list skills: ${err}`),
      };
    }
  }
  async getSkill(name, options) {
    const result = await this.listSkills(options);
    if (!result.ok) return result;
    return { ok: true, value: result.value.find((s) => s.name === name) };
  }
  async matchSkills(text, options) {
    const result = await this.listSkills(options);
    if (!result.ok) return result;
    const lower = text.toLowerCase();
    return {
      ok: true,
      value: result.value.filter(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          s.description.toLowerCase().includes(lower),
      ),
    };
  }
}
//# sourceMappingURL=filesystem-skill-manager.js.map
