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
import type {
  CallOptions,
  ISkill,
  ISkillManager,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SkillError } from '@mcp-abap-adt/llm-agent';
export declare class ClaudeSkillManager implements ISkillManager {
  private cache;
  private readonly dirs;
  constructor(projectRoot?: string);
  listSkills(_options?: CallOptions): Promise<Result<ISkill[], SkillError>>;
  getSkill(
    name: string,
    options?: CallOptions,
  ): Promise<Result<ISkill | undefined, SkillError>>;
  matchSkills(
    text: string,
    options?: CallOptions,
  ): Promise<Result<ISkill[], SkillError>>;
}
//# sourceMappingURL=claude-skill-manager.d.ts.map
