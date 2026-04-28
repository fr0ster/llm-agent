/**
 * ClaudeSkillManager — discovers skills from Claude Code skill directories.
 *
 * Discovery paths:
 * - `~/.claude/skills/`
 * - `<projectRoot>/.claude/skills/`
 *
 * Handles Claude-specific frontmatter key mapping:
 * - `disable-model-invocation` → `disableModelInvocation`
 * - `allowed-tools` → `allowedTools`
 * - `user-invocable` → `userInvocable`
 * - `argument-hint` → `argumentHint`
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  CallOptions,
  ISkill,
  ISkillManager,
  ISkillMeta,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SkillError } from '@mcp-abap-adt/llm-agent';
import { scanDirsForSkills } from './skill-utils.js';

export class ClaudeSkillManager implements ISkillManager {
  private cache: ISkill[] | undefined;
  private readonly dirs: string[];

  constructor(projectRoot?: string) {
    this.dirs = [join(homedir(), '.claude', 'skills')];
    if (projectRoot) {
      this.dirs.push(join(projectRoot, '.claude', 'skills'));
    }
  }

  async listSkills(
    _options?: CallOptions,
  ): Promise<Result<ISkill[], SkillError>> {
    if (this.cache) return { ok: true, value: this.cache };

    try {
      const skills = await scanDirsForSkills(this.dirs, normalizeClaudeMeta);
      this.cache = skills;
      return { ok: true, value: skills };
    } catch (err) {
      return {
        ok: false,
        error: new SkillError(`Failed to list Claude skills: ${err}`),
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

/** Map Claude-specific kebab-case frontmatter keys to camelCase ISkillMeta. */
function normalizeClaudeMeta(meta: ISkillMeta): ISkillMeta {
  const result = { ...meta };

  if ('disable-model-invocation' in result) {
    result.disableModelInvocation = result[
      'disable-model-invocation'
    ] as boolean;
    delete (result as Record<string, unknown>)['disable-model-invocation'];
  }
  if ('allowed-tools' in result) {
    result.allowedTools = result['allowed-tools'] as string[];
    delete (result as Record<string, unknown>)['allowed-tools'];
  }
  if ('user-invocable' in result) {
    result.userInvocable = result['user-invocable'] as boolean;
    delete (result as Record<string, unknown>)['user-invocable'];
  }
  if ('argument-hint' in result) {
    result.argumentHint = result['argument-hint'] as string;
    delete (result as Record<string, unknown>)['argument-hint'];
  }

  return result;
}
