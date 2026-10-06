// packages/llm-agent-libs/src/collections/tools/tool-text.ts
/**
 * Provider text composers (spec §7.3.1, review finding 4). The default stays C0:
 * the least schema text over 30.1.0's record (D55 — no figure justifies it).
 * C0e / C0s are strategies in no named composition; a consumer's measurement
 * found no winner among the three (evidence, spec §7.3.1). Provider words only —
 * nothing is written over the provider's text.
 */
import type { IToolTextComposer, ToolItem } from '@mcp-abap-adt/llm-agent';
import { firstClause } from './derive-tool-facets.js';

/** C0: `Tool: <name> — <description>` + `\nParameters: a, b` (the 30.1.0-shaped text). */
export function fullToolText(tool: ToolItem): string {
  const head = `Tool: ${tool.name} — ${tool.description}`;
  return tool.parameters.length > 0
    ? `${head}\nParameters: ${tool.parameters.map((p) => p.name).join(', ')}`
    : head;
}

/** C0 — the default. */
export class ParameterNamesToolText implements IToolTextComposer {
  readonly name = 'parameter-names';
  compose(tool: ToolItem): string {
    return fullToolText(tool);
  }
}

/** C0e — C0 + one line per parameter with string values: `<param>: <v1>, <v2>`. */
export class EnumValuesToolText implements IToolTextComposer {
  readonly name = 'enum-values';
  compose(tool: ToolItem): string {
    const lines = tool.parameters
      .filter((p) => p.values.length > 0)
      .map((p) => `${p.name}: ${p.values.map((v) => v.value).join(', ')}`);
    return [fullToolText(tool), ...lines].join('\n');
  }
}

/** C0s — C0 + one line per parameter with a description or values:
 *  `<param>: <first clause>` and/or `values <v1>, <v2>` (joined by `; `). */
export class SchemaToolText implements IToolTextComposer {
  readonly name = 'schema';
  compose(tool: ToolItem): string {
    const lines = tool.parameters.flatMap((p) => {
      const clause = p.description ? firstClause(p.description) : '';
      const parts = [
        ...(clause ? [clause] : []),
        ...(p.values.length > 0
          ? [`values ${p.values.map((v) => v.value).join(', ')}`]
          : []),
      ];
      return parts.length > 0 ? [`${p.name}: ${parts.join('; ')}`] : [];
    });
    return [fullToolText(tool), ...lines].join('\n');
  }
}
