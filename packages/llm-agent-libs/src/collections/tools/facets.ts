// packages/llm-agent-libs/src/collections/tools/facets.ts
import type { IToolFacet, ToolItem } from '@mcp-abap-adt/llm-agent';
import { firstClause, nameWords, valueWords } from './derive-tool-facets.js';

/** `<name words> — <first clause of description>` (the measured `operation` record, renamed). */
export class SummaryFacet implements IToolFacet {
  readonly kind = 'summary';
  derive(tool: ToolItem): string | undefined {
    const clause = firstClause(tool.description);
    return clause ? `${nameWords(tool.originalName)} — ${clause}` : undefined;
  }
}

/** What the tool acts on, from the input SCHEMA (spec §7.3.1). Not yet measured (D16). */
export class ParametersFacet implements IToolFacet {
  readonly kind = 'parameters';
  derive(tool: ToolItem): string | undefined {
    if (tool.parameters.length === 0) return undefined;
    const parts = tool.parameters.map((p) => {
      const clause = p.description ? firstClause(p.description) : '';
      const values = p.values.map((v) => valueWords(v.value)).join(', ');
      return (
        nameWords(p.name) +
        (clause ? ` (${clause})` : '') +
        (values ? `: ${values}` : '')
      );
    });
    return `${nameWords(tool.originalName)} — ${parts.join('; ')}`;
  }
}

/**
 * OPT-IN, convention-dependent (spec §7.3.1): the name words after the first
 * one. On verb-first names (`GetClass`) that is the object; on object-first
 * names it is the operation; on single-word names nothing. In no variant.
 */
export class NameTailFacet implements IToolFacet {
  readonly kind = 'name-tail';
  derive(tool: ToolItem): string | undefined {
    const words = nameWords(tool.originalName).split(' ');
    return words.length >= 2 ? words.slice(1).join(' ') : undefined;
  }
}
