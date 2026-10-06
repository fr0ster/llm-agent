import type {
  IDiscriminatorSelector,
  IIndexNoteSource,
  IndexNote,
  ToolItem,
  ToolParameter,
} from '@mcp-abap-adt/llm-agent';

/**
 * The ONE top-level property that is `required` and has ≥ 2 string values.
 * None or several → none (D18: no fan-out; the consumer resolves an ambiguity
 * with NamedDiscriminator or its own selector).
 */
export class RequiredEnumDiscriminator
  implements IDiscriminatorSelector, IIndexNoteSource<ToolItem>
{
  readonly name = 'required-enum';
  static candidates(tool: ToolItem): readonly ToolParameter[] {
    return tool.parameters.filter((p) => p.required && p.values.length >= 2);
  }
  select(tool: ToolItem): ToolParameter | undefined {
    const c = RequiredEnumDiscriminator.candidates(tool);
    return c.length === 1 ? c[0] : undefined;
  }
  /** S1: never a guess — several candidates are reported, not picked (D18). */
  notesFor(tool: ToolItem): readonly IndexNote[] {
    const c = RequiredEnumDiscriminator.candidates(tool);
    return c.length > 1
      ? [
          {
            note: 'ambiguous-discriminator',
            detail: c.map((p) => p.name).join(', '),
          },
        ]
      : [];
  }
}

/** The property with this name, when it has ≥ 2 string values. */
export class NamedDiscriminator implements IDiscriminatorSelector {
  readonly name = 'named';
  constructor(readonly parameter: string) {}
  select(tool: ToolItem): ToolParameter | undefined {
    const p = tool.parameters.find((x) => x.name === this.parameter);
    return p && p.values.length >= 2 ? p : undefined;
  }
}
