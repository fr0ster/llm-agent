import type {
  ToolItem,
  ToolParameter,
  ToolParameterValue,
} from '@mcp-abap-adt/llm-agent';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A non-empty string, or absent. A present value of another type is ignored text. */
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function malformed(tool: string, what: string): Error {
  return new TypeError(`Tool "${tool}": malformed input schema — ${what}`);
}

function readAlternatives(
  tool: string,
  param: string,
  key: 'oneOf' | 'anyOf',
  raw: unknown,
): ToolParameterValue[] {
  if (!Array.isArray(raw)) {
    throw malformed(tool, `"${param}".${key} is not an array`);
  }
  const out: ToolParameterValue[] = [];
  for (const alt of raw) {
    if (typeof alt === 'boolean') continue;
    if (!isObj(alt)) {
      throw malformed(
        tool,
        `"${param}".${key} has an entry that is not an object`,
      );
    }
    // Only string constants name a value; other alternatives (types, numbers) are not values.
    if (typeof alt.const !== 'string') continue;
    const description = text(alt.description) ?? text(alt.title);
    out.push({ value: alt.const, ...(description ? { description } : {}) });
  }
  return out;
}

function readValues(tool: string, param: string, p: Obj): ToolParameterValue[] {
  if (p.enum !== undefined) {
    if (!Array.isArray(p.enum)) {
      throw malformed(tool, `"${param}".enum is not an array`);
    }
    return p.enum
      .filter((v): v is string => typeof v === 'string')
      .map((value) => ({ value }));
  }
  if (p.oneOf !== undefined) {
    return readAlternatives(tool, param, 'oneOf', p.oneOf);
  }
  if (p.anyOf !== undefined) {
    return readAlternatives(tool, param, 'anyOf', p.anyOf);
  }
  return [];
}

function readParameters(tool: string, schema: Obj): ToolParameter[] {
  if (schema.properties === undefined) return [];
  if (!isObj(schema.properties)) {
    throw malformed(tool, '"properties" is not an object');
  }
  let required = new Set<string>();
  if (schema.required !== undefined) {
    const names: unknown[] = Array.isArray(schema.required)
      ? schema.required
      : [];
    const strings = names.filter((r): r is string => typeof r === 'string');
    if (!Array.isArray(schema.required) || strings.length !== names.length) {
      throw malformed(tool, '"required" is not an array of strings');
    }
    required = new Set(strings);
  }
  return Object.entries(schema.properties).map(([name, raw]) => {
    if (typeof raw === 'boolean') {
      return { name, required: required.has(name), values: [] };
    }
    if (!isObj(raw)) {
      throw malformed(tool, `property "${name}" is not an object or boolean`);
    }
    const description = text(raw.description);
    return {
      name,
      ...(description ? { description } : {}),
      required: required.has(name),
      values: readValues(tool, name, raw),
    };
  });
}

/**
 * A ToolItem from what ANY MCP server exports (spec §3.5, §7.6): top-level
 * `properties`, `required`, string `enum` / `const` values. No server is special-cased.
 * An absent part is simply absent; a part present but of the wrong shape throws.
 */
export function toolItemFromTool(
  tool: { name: string; description?: string; inputSchema?: Obj },
  ids: { itemId: string; originalName: string },
): ToolItem {
  const description = tool.description ?? '';
  const inputSchema = tool.inputSchema ?? {};
  return {
    itemId: ids.itemId,
    name: tool.name,
    originalName: ids.originalName,
    description,
    parameters: readParameters(tool.name, inputSchema),
    inputSchema,
    definitionChars: JSON.stringify({
      name: tool.name,
      description,
      inputSchema,
    }).length,
  };
}
