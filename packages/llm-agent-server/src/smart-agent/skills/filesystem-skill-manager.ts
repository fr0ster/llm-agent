/**
 * FileSystemSkillManager — discovers skills from configurable directories.
 *
 * The simplest skill manager variant — no vendor-specific logic.
 * Takes an array of directories to scan for skill subdirectories.
 */

import type {
  CallOptions,
  ISkill,
  ISkillManager,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SkillError } from '@mcp-abap-adt/llm-agent';
import { scanDirsForSkills } from './skill-utils.js';

export class FileSystemSkillManager implements ISkillManager {
  private cache: ISkill[] | undefined;

  constructor(private readonly dirs: string[]) {}

  async listSkills(
    _options?: CallOptions,
  ): Promise<Result<ISkill[], SkillError>> {
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
