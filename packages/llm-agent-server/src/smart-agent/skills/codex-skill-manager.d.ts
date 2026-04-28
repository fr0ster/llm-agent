/**
 * CodexSkillManager — discovers skills from Codex/OpenAI agent skill directories.
 *
 * Discovery paths:
 * - `~/.agents/skills/`
 * - `<projectRoot>/.agents/skills/`
 *
 * Parses optional `agents/openai.yaml` into meta extensions.
 */
import type { CallOptions, ISkill, ISkillManager, Result } from '@mcp-abap-adt/llm-agent';
import { SkillError } from '@mcp-abap-adt/llm-agent';
export declare class CodexSkillManager implements ISkillManager {
    private cache;
    private readonly dirs;
    constructor(projectRoot?: string);
    listSkills(_options?: CallOptions): Promise<Result<ISkill[], SkillError>>;
    getSkill(name: string, options?: CallOptions): Promise<Result<ISkill | undefined, SkillError>>;
    matchSkills(text: string, options?: CallOptions): Promise<Result<ISkill[], SkillError>>;
}
//# sourceMappingURL=codex-skill-manager.d.ts.map