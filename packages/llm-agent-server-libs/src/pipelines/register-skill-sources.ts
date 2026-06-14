import type { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { skillsRagSource } from '@mcp-abap-adt/llm-agent-libs';
import type { IServerPipelineContext } from './server-context.js';

/**
 * Section/store key under which the skills RAG source is registered. A single
 * key (not per-group) keeps the assembler's "Relevant Skills" section stable
 * regardless of how many groups the host serves; the title-cased key becomes
 * the section header automatically.
 */
const SKILLS_STORE_KEY = 'relevant-skills';

/**
 * Implicit assembler wiring (B3): when a skill plugin-host is present on the
 * context, register each served skill group's RAG handle as one more
 * {@link skillsRagSource} `IRag` source on the agent builder. Called ONCE at
 * build time by the assembler-based pipelines (flat/default, linear) — the
 * serving collection set is fixed at host load.
 *
 * Absent `ctx.skillHost` this is a NO-OP (zero behavior change).
 *
 * Each group is registered under its own collection name so distinct groups do
 * not collide in the RAG registry; all derive from the same `relevant-skills`
 * base key so the assembler renders them under one "Relevant Skills" header
 * family. Recall sizing (`k`/`threshold`) comes from `ctx.skillRecall`, threaded
 * from the `skillPlugins:` host config.
 *
 * @returns the same builder (fluent), for call-site chaining.
 */
export function registerSkillSources(
  builder: SmartAgentBuilder,
  ctx: IServerPipelineContext,
): SmartAgentBuilder {
  const host = ctx.skillHost;
  if (!host) return builder;

  const k = ctx.skillRecall?.k ?? 4;
  const threshold = ctx.skillRecall?.threshold;

  // Honor the operator-configured served subset (`skillPlugins.serveCollections`):
  // register ONLY those groups so conflicting groups are not read together. When
  // unset, register every group the host serves (prior behavior).
  const serve = ctx.skillRecall?.serveCollections;
  const served = serve !== undefined ? new Set(serve) : undefined;

  let out = builder;
  for (const g of host.groups()) {
    if (served && !served.has(g.group)) continue;
    const name = `${SKILLS_STORE_KEY}:${g.group}`;
    out = out.addRagCollection({
      name,
      rag: skillsRagSource(host.rag(g.group), {
        group: g.group,
        k,
        ...(threshold !== undefined ? { threshold } : {}),
      }),
      meta: {
        displayName: 'Relevant Skills',
        scope: 'global',
      },
    });
  }
  return out;
}
