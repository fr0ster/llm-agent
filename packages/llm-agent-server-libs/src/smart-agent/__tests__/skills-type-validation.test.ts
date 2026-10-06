/**
 * Spec §10.5.8 S-10, D89 — an unknown `skills.type` in a config built in code
 * (which skips the YAML field validator, Task 4M's `checkSkills`) fails the
 * start in `resolveSkillManager`, naming `skills.type` — never a server
 * without a skill manager.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const BASE_YAML = `
llm:
  provider: openai
  model: gpt-4o
rag:
  store:
    type: in-memory
`;

describe('S-10 skills.type', () => {
  it("a config built in code with skills.type 'nope' fails start(), naming skills.type", async () => {
    const server = new SmartServer(
      {
        ...resolveSmartServerConfig(
          {},
          parse(BASE_YAML),
          {},
          { skipProviderRuntimeChecks: true },
        ),
        port: 0,
        skipModelValidation: true,
        skills: { type: 'nope' },
      } as unknown as SmartServerConfig,
      constructionSeams,
    );
    await assert.rejects(
      server.start(),
      /skills\.type.*'nope'.*claude, codex, filesystem/,
    );
  });
});
