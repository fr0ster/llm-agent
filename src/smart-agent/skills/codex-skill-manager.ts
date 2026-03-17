/**
 * CodexSkillManager — discovers skills from Codex/OpenAI agent skill directories.
 *
 * Discovery paths:
 * - `~/.agents/skills/`
 * - `<projectRoot>/.agents/skills/`
 *
 * Parses optional `agents/openai.yaml` into meta extensions.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ISkill, ISkillManager } from '../interfaces/skill.js';
import type { CallOptions, Result } from '../interfaces/types.js';
import { SkillError } from '../interfaces/types.js';
import type { FileSystemSkill } from './filesystem-skill.js';
import { scanDirsForSkills } from './skill-utils.js';

export class CodexSkillManager implements ISkillManager {
  private cache: ISkill[] | undefined;
  private readonly dirs: string[];

  constructor(projectRoot?: string) {
    this.dirs = [join(homedir(), '.agents', 'skills')];
    if (projectRoot) {
      this.dirs.push(join(projectRoot, '.agents', 'skills'));
    }
  }

  async listSkills(
    _options?: CallOptions,
  ): Promise<Result<ISkill[], SkillError>> {
    if (this.cache) return { ok: true, value: this.cache };

    try {
      const skills = await scanDirsForSkills(
        this.dirs,
        undefined,
        enrichCodexMeta,
      );
      this.cache = skills;
      return { ok: true, value: skills };
    } catch (err) {
      return {
        ok: false,
        error: new SkillError(`Failed to list Codex skills: ${err}`),
      };
    }
  }

  async getSkill(
    name: string,
    options?: CallOptions,
  ): Promise<Result<ISkill | undefined, SkillError>> {
    const result = await this.listSkills(options);
    if (!result.ok) return result;
    return { ok: true, value: result.value.find((s) => s.name === name) };
  }

  async matchSkills(
    text: string,
    options?: CallOptions,
  ): Promise<Result<ISkill[], SkillError>> {
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

/**
 * Load optional `agents/openai.yaml` from the skill directory and merge
 * its contents into the skill's meta as vendor-specific extensions.
 */
async function enrichCodexMeta(
  skill: FileSystemSkill,
  dir: string,
): Promise<void> {
  try {
    const yamlPath = join(dir, 'agents', 'openai.yaml');
    const raw = await readFile(yamlPath, 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object') {
      Object.assign(skill.meta, { openai: parsed });
    }
  } catch {
    // No openai.yaml — that's fine
  }
}
